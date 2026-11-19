import { createHash, randomUUID } from "node:crypto";
import { CloudEvent } from "cloudevents";
import { z } from "zod";
import type { Claim } from "../analysis/claim.js";
import type { ComparisonResult } from "../analysis/historical-comparison.js";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { EvidenceSourceSchema } from "../research/research-entry.js";
import type { ApplicabilityResult } from "../research/applicability.js";

/**
 * Evidence selection and versioned drafting brief (#41).
 *
 * Gathers, for one source post, the grounded claims (#32), the applicable
 * research evidence chosen by the applicability assessment (#39) and any
 * historical comparison findings (#36), checks that every piece belongs to
 * the same source version, and saves an immutable brief to Git.
 *
 * - Only selected (current, independent, applicable) evidence is included,
 *   each with a stable citation ID and its exact entry and archive versions.
 * - A claim without supporting evidence is listed as an evidence gap and
 *   left out of the critique; when no claim has support the result is an
 *   explicit gap and no brief is saved.
 * - Historical findings are optional: their absence never blocks a brief.
 * - After the durable save, a metadata pointer event is handed off through
 *   the state controller. No drafting, browsing or publication happens here.
 */

export const BRIEF_SCHEMA_VERSION = 1;
export const BRIEF_READY_SUBJECT = "steele.v1.brief.ready";
export const BRIEF_READY_EVENT_TYPE_V1 = "org.steele.brief.ready.v1";
export const BRIEF_READY_DATASCHEMA_V1 = "urn:steele:schema:brief-ready:v1";

const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

export const BriefCitationSchema = z
  .object({
    citationId: z.string().regex(/^E[1-9][0-9]*$/),
    entryId: z.string().min(1),
    entryRevision: z.number().int().min(1),
    entryArtifact: ArtifactReferenceSchema,
    evidence: EvidenceSourceSchema,
  })
  .strict();

export const DraftingBriefSchema = z
  .object({
    schemaVersion: z.literal(BRIEF_SCHEMA_VERSION),
    source: z
      .object({
        publicationId: Id,
        postId: Id,
        url: z.url({ protocol: /^https$/ }),
        sourceVersion: Hash,
        artifact: ArtifactReferenceSchema,
        ingestionReason: z.enum(["live", "backfill", "reprocess"]),
      })
      .strict(),
    claims: z
      .array(
        z
          .object({
            claimId: Hash,
            statement: z.string().min(1),
            passage: z.string().min(1),
            span: z
              .object({ start: z.number().int().min(0), end: z.number().int().min(1) })
              .strict(),
            citationIds: z.array(z.string()).min(1),
            limitations: z.array(z.string()),
            gaps: z.array(z.string()),
            /** Research findings the applicable entries left unresolved, with their reasons. */
            unresolved: z.array(
              z
                .object({
                  entryId: z.string(),
                  statement: z.string(),
                  reason: z.string().optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .min(1),
    citations: z.array(BriefCitationSchema).min(1),
    history: z.array(z.unknown()),
    evidenceGaps: z.array(
      z.object({ claimId: Hash, statement: z.string(), gaps: z.array(z.string()) }).strict(),
    ),
  })
  .strict()
  .superRefine((b, ctx) => {
    const ids = new Set(b.citations.map((c) => c.citationId));
    if (ids.size !== b.citations.length)
      ctx.addIssue({ code: "custom", message: "duplicate citation ID" });
    for (const c of b.claims) {
      for (const id of c.citationIds) {
        if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `unknown citation ${id}` });
      }
    }
  });
export type DraftingBrief = z.infer<typeof DraftingBriefSchema>;

export interface BriefInput {
  source: DraftingBrief["source"];
  claims: Array<
    Pick<Claim, "id" | "statement" | "passage" | "span" | "artifact" | "sourceVersion">
  >;
  /** Applicability assessment per claim (#39). */
  assessments: ApplicabilityResult[];
  /** Optional historical comparison results (#36). */
  comparisons?: ComparisonResult[];
}

export type BriefSelection =
  | { kind: "brief"; brief: DraftingBrief }
  | { kind: "evidence-gap"; gaps: DraftingBrief["evidenceGaps"] }
  | { kind: "provenance-mismatch"; reason: string };

const sameArtifact = (a: ArtifactReference, b: ArtifactReference) =>
  a.repository === b.repository && a.commit === b.commit && a.path === b.path && a.hash === b.hash;

/** Pure selection: validate provenance and choose supported claims and evidence. */
export function selectBriefEvidence(input: BriefInput): BriefSelection {
  const { source } = input;
  for (const c of input.claims) {
    if (c.sourceVersion !== source.sourceVersion || !sameArtifact(c.artifact, source.artifact)) {
      return {
        kind: "provenance-mismatch",
        reason: `claim ${c.id} belongs to another source version`,
      };
    }
  }
  const claimIds = new Set(input.claims.map((c) => c.id));
  const byClaim = new Map<string, ApplicabilityResult>();
  for (const a of input.assessments) {
    if (!claimIds.has(a.claimId)) {
      return { kind: "provenance-mismatch", reason: `assessment for unknown claim ${a.claimId}` };
    }
    if (byClaim.has(a.claimId))
      return { kind: "provenance-mismatch", reason: `duplicate assessment ${a.claimId}` };
    byClaim.set(a.claimId, a);
  }
  const history: ComparisonResult[] = [];
  for (const h of input.comparisons ?? []) {
    if (!claimIds.has(h.claimId)) {
      return { kind: "provenance-mismatch", reason: `comparison for unknown claim ${h.claimId}` };
    }
    for (const f of h.findings) {
      if (
        !sameArtifact(f.current.artifact, source.artifact) ||
        f.current.sourceVersion !== source.sourceVersion
      ) {
        return {
          kind: "provenance-mismatch",
          reason: `comparison for claim ${h.claimId} cites another source version`,
        };
      }
    }
    history.push(h);
  }

  const citations: DraftingBrief["citations"] = [];
  const citationKey = new Map<string, string>();
  const claims: DraftingBrief["claims"] = [];
  const evidenceGaps: DraftingBrief["evidenceGaps"] = [];
  // Deterministic order: by position in the source.
  for (const c of [...input.claims].sort(
    (a, b) => a.span.start - b.span.start || a.id.localeCompare(b.id),
  )) {
    const a = byClaim.get(c.id);
    if (!a || a.selected.length === 0) {
      evidenceGaps.push({
        claimId: c.id,
        statement: c.statement,
        gaps: a?.gaps.length ? a.gaps : [c.statement],
      });
      continue;
    }
    const ids: string[] = [];
    for (const s of a.selected) {
      const key = JSON.stringify([s.entryId, s.revision, s.evidence.url, s.evidence.passage]);
      let id = citationKey.get(key);
      if (!id) {
        id = `E${citations.length + 1}`;
        citationKey.set(key, id);
        citations.push({
          citationId: id,
          entryId: s.entryId,
          entryRevision: s.revision,
          entryArtifact: s.entryArtifact,
          evidence: s.evidence,
        });
      }
      if (!ids.includes(id)) ids.push(id);
    }
    const limitations = [...new Set(a.assessments.flatMap((x) => x.limitations))];
    claims.push({
      claimId: c.id,
      statement: c.statement,
      passage: c.passage,
      span: { start: c.span.start, end: c.span.end },
      citationIds: ids,
      limitations,
      gaps: a.gaps,
      unresolved: a.assessments
        .filter((x) => x.applicability !== "not-applicable")
        .flatMap((x) =>
          x.unresolved.map((u) => ({
            entryId: x.entryId,
            statement: u.statement,
            ...(u.reason ? { reason: u.reason } : {}),
          })),
        ),
    });
  }
  // Missing material evidence for every claim is a gap, not a brief.
  if (claims.length === 0) return { kind: "evidence-gap", gaps: evidenceGaps };
  const brief = DraftingBriefSchema.parse({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    source,
    claims,
    citations,
    history,
    evidenceGaps,
  });
  return { kind: "brief", brief };
}

export type SaveBriefOutcome =
  | { kind: "saved"; artifact: ArtifactRef; reused: boolean }
  | { kind: "evidence-gap"; gaps: DraftingBrief["evidenceGaps"] }
  | { kind: "provenance-mismatch"; reason: string }
  | { kind: "busy" | "exhausted" }
  | { kind: "failed"; reason: string };

/**
 * Select, then durably save the brief and hand off a metadata pointer.
 * Content-addressed: the same inputs produce the same brief and path, so a
 * repeat is reused rather than saved twice.
 */
export async function saveDraftingBrief(input: {
  brief: BriefInput;
  artifacts: Pick<GitArtifactStore, "write" | "lookup">;
  operations: OperationStore;
  owner: string;
  correlationId?: string;
}): Promise<SaveBriefOutcome> {
  const selection = selectBriefEvidence(input.brief);
  if (selection.kind !== "brief") return selection;
  const content = `${JSON.stringify(selection.brief, null, 2)}\n`;
  const hash = createHash("sha256").update(content).digest("hex");
  const { publicationId, postId } = selection.brief.source;
  const path = `briefs/${publicationId}/${postId}/${hash}.json`;
  const key = `brief:${hash}`;

  const claimed = input.operations.claim(key, input.owner, 5 * 60_000, 5);
  if (claimed.kind === "busy") return { kind: "busy" };
  if (claimed.kind === "exhausted") {
    // A final attempt may have committed the brief and stopped before
    // completing: finish from that artifact instead of abandoning it.
    let committed: ArtifactRef | undefined;
    try {
      committed = await input.artifacts.lookup(path);
    } catch {
      return { kind: "failed", reason: "lookup-failed" };
    }
    if (!committed) return { kind: "exhausted" };
    input.operations.reconcileCompleted(key, { path: committed.path, commit: committed.commit }, [
      readyEvent(selection.brief, committed, input.correlationId),
    ]);
    return { kind: "saved", artifact: committed, reused: true };
  }
  if (claimed.kind === "completed") {
    const existing = await input.artifacts.lookup(path);
    return existing
      ? { kind: "saved", artifact: existing, reused: true }
      : { kind: "failed", reason: "missing-artifact" };
  }
  let artifact: ArtifactRef;
  try {
    artifact = await input.artifacts.write(path, content);
  } catch (error) {
    const existing =
      error instanceof ArtifactStoreError && error.code === "immutable-conflict"
        ? await input.artifacts.lookup(path)
        : undefined;
    if (!existing) {
      input.operations.fail(claimed.claim, "brief:commit-failed", true);
      return { kind: "failed", reason: "commit-failed" };
    }
    artifact = existing;
  }
  input.operations.complete(claimed.claim, { path: artifact.path, commit: artifact.commit }, [
    readyEvent(selection.brief, artifact, input.correlationId),
  ]);
  return { kind: "saved", artifact, reused: false };
}

/** The `brief.ready` metadata pointer for a saved brief, as a pending event record. */
function readyEvent(
  brief: DraftingBrief,
  artifact: ArtifactRef,
  correlationId: string | undefined,
): { eventId: string; subject: string; payload: string } {
  const { publicationId, postId } = brief.source;
  const event = new CloudEvent({
    specversion: "1.0",
    id: randomUUID(),
    source: "urn:steele:drafting:brief",
    type: BRIEF_READY_EVENT_TYPE_V1,
    time: new Date().toISOString(),
    subject: `substack/${publicationId}/${postId}`,
    datacontenttype: "application/json",
    dataschema: BRIEF_READY_DATASCHEMA_V1,
    ...(correlationId ? { correlationid: correlationId } : {}),
    data: {
      publicationId,
      postId,
      ingestionReason: brief.source.ingestionReason,
      brief: {
        repository: artifact.repository,
        commit: artifact.commit,
        path: artifact.path,
        hash: `sha256:${artifact.sha256}`,
      },
      claims: brief.claims.length,
      citations: brief.citations.length,
      evidenceGaps: brief.evidenceGaps.length,
    },
  });
  return {
    eventId: event.id,
    subject: BRIEF_READY_SUBJECT,
    payload: JSON.stringify(event.toJSON()),
  };
}
