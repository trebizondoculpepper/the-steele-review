import { createHash } from "node:crypto";
import type { ArtifactReference } from "../content/artifact-reference.js";
import type { DraftingBrief } from "../drafting/brief.js";
import { DossierMetadataSchema, type DossierMetadata } from "./dossier.js";
import type { SelectedEvidence } from "./applicability.js";
import { ResearchEntrySchema, type EvidenceSource, type ResearchEntry } from "./research-entry.js";
import type { ResearchCandidate } from "./research-store.js";

/**
 * Bridge between versioned theme dossiers (#146) and the structured research
 * corpus used by applicability assessment (#39) and brief selection (#41).
 *
 * The two representations answer different questions and neither replaces the
 * other:
 *
 * - A research entry is written once per normalised question and addressed
 *   claim, with evidence that is explicitly `external` or `monitored`.
 * - A dossier is written per theme and addresses the *occurrences* of claims in
 *   the monitored material, which have their own source-grounded IDs.
 *
 * This module is pure projection: no Git, SQL, model or network access. The
 * only bridge between the two ID spaces is an explicit, validated
 * {@link OccurrenceClaimLink} list, so a canonical claim ID is never silently
 * substituted where a source-grounded occurrence ID is expected.
 *
 * Provenance rules enforced here:
 * - Only `external` evidence becomes dossier coverage. Monitored material is
 *   never promoted to independent support, even when the research entry cites
 *   it next to genuine evidence.
 * - `sourceDate` comes only from a source publication date; `checkedAt` is a
 *   retrieval fact, never a substitute for a missing publication date.
 * - Every citation carries the entry ID, the exact revision and the immutable
 *   artifact reference, so a reader can re-read the committed record.
 */

type DossierCitation = DossierMetadata["citations"][number];

const CLAIM_ID = /^sha256:[0-9a-f]{64}$/;

export type DossierBridgeErrorCode =
  | "invalid-claim-id"
  | "duplicate-occurrence"
  | "unknown-claim"
  | "unknown-entry"
  | "duplicate-entry"
  | "unknown-citation"
  | "duplicate-citation"
  | "citation-mismatch"
  | "monitored-citation";

export class DossierBridgeError extends Error {
  constructor(
    readonly code: DossierBridgeErrorCode,
    message: string,
  ) {
    super(`dossier bridge: ${message}`);
    this.name = "DossierBridgeError";
  }
}

/** One committed research revision, as stored by the research corpus. */
export interface ResearchReference {
  entryId: string;
  revision: number;
  artifact: ArtifactReference;
  entry: ResearchEntry;
}

/** Explicit link between one source-grounded occurrence and one reusable claim. */
export interface OccurrenceClaimLink {
  /** `Claim.id` of the occurrence in the monitored source. */
  occurrenceClaimId: string;
  /** Normalised claim ID used by research entries. */
  normalisedClaimId: string;
}

/** A dossier citation plus the full committed evidence it was projected from. */
export interface DossierCitationLink {
  citationId: string;
  entryId: string;
  revision: number;
  entryArtifact: ArtifactReference;
  evidence: EvidenceSource;
}

export interface DossierProjectionInput {
  themeId: string;
  title: string;
  scope: string;
  updatedAt: string;
  /** Committed research revisions that may contribute coverage. */
  references: ResearchReference[];
  /** Explicit occurrence-to-normalised claim mapping. Never inferred. */
  links: OccurrenceClaimLink[];
}

export interface DossierProjection {
  metadata: DossierMetadata;
  citations: DossierCitationLink[];
  links: OccurrenceClaimLink[];
}

function assertClaimId(id: string, kind: string): void {
  if (!CLAIM_ID.test(id)) {
    throw new DossierBridgeError("invalid-claim-id", `${kind} is not a claim ID`);
  }
}

/** Stable dossier citation ID for one committed evidence item. */
export function dossierCitationId(link: {
  entryId: string;
  revision: number;
  evidence: Pick<EvidenceSource, "url" | "passage">;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([link.entryId, link.revision, link.evidence.url, link.evidence.passage]),
      "utf8",
    )
    .digest("hex");
  return `c-${hash.slice(0, 16)}`;
}

/** Traceability key shared with brief citation selection. */
export function citationTraceKey(citation: {
  entryId: string;
  revision: number;
  evidence: Pick<EvidenceSource, "url" | "passage">;
}): string {
  return JSON.stringify([
    citation.entryId,
    citation.revision,
    citation.evidence.url,
    citation.evidence.passage,
  ]);
}

function toDossierCitation(link: DossierCitationLink): DossierCitation {
  return {
    id: link.citationId,
    url: link.evidence.url,
    title: link.evidence.title,
    passage: link.evidence.passage,
    ...(link.evidence.publishedAt === undefined ? {} : { sourceDate: link.evidence.publishedAt }),
    checkedAt: link.evidence.lastCheckedAt,
  };
}

function sameArtifact(a: ArtifactReference | undefined, b: ArtifactReference | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.repository === b.repository && a.commit === b.commit && a.path === b.path && a.hash === b.hash
  );
}

/** Full provenance equality, not just the fields the citation ID covers. */
function sameProvenance(a: EvidenceSource, b: EvidenceSource): boolean {
  return (
    a.kind === b.kind &&
    a.url === b.url &&
    a.title === b.title &&
    a.publisher === b.publisher &&
    a.publishedAt === b.publishedAt &&
    a.retrievedAt === b.retrievedAt &&
    a.lastCheckedAt === b.lastCheckedAt &&
    a.passage === b.passage &&
    sameArtifact(a.artifact, b.artifact)
  );
}

/**
 * Project committed research references into dossier coverage.
 *
 * A mapped claim becomes `covered` only when a settled finding (supported or
 * contradicted) is backed by at least one external source. Otherwise it stays
 * a gap with a stated reason, so an unsupported claim never looks resolved.
 */
export function buildDossierProjection(input: DossierProjectionInput): DossierProjection {
  const seenOccurrences = new Set<string>();
  for (const link of input.links) {
    assertClaimId(link.occurrenceClaimId, "occurrence claim");
    assertClaimId(link.normalisedClaimId, "normalised claim");
    if (seenOccurrences.has(link.occurrenceClaimId)) {
      throw new DossierBridgeError(
        "duplicate-occurrence",
        `occurrence ${link.occurrenceClaimId} is mapped twice`,
      );
    }
    seenOccurrences.add(link.occurrenceClaimId);
  }

  const references = new Map<string, ResearchReference>();
  for (const reference of input.references) {
    const key = `${reference.entryId}@${reference.revision}`;
    if (references.has(key)) {
      throw new DossierBridgeError("duplicate-entry", `entry ${key} is supplied twice`);
    }
    references.set(key, {
      ...reference,
      entry: ResearchEntrySchema.parse(reference.entry),
    });
  }

  const citationById = new Map<string, DossierCitationLink>();
  const claims: DossierMetadata["claims"] = [];

  for (const link of input.links) {
    const matched = [...references.values()].flatMap((reference) =>
      reference.entry.addressedClaims
        .filter((claim) => claim.claimId === link.normalisedClaimId)
        .map((claim) => ({ reference, claim })),
    );
    if (matched.length === 0) {
      throw new DossierBridgeError(
        "unknown-claim",
        `no supplied research entry addresses ${link.normalisedClaimId}`,
      );
    }

    const settled = matched.filter(
      ({ claim }) =>
        (claim.finding === "supported" || claim.finding === "contradicted") &&
        claim.evidence.some((evidence) => evidence.kind === "external"),
    );

    if (settled.length === 0) {
      const unresolved = matched.find(({ claim }) => claim.finding === "unresolved");
      const reason = unresolved
        ? (unresolved.claim.unresolvedReason ?? "research entry left this claim unresolved")
        : matched.some(({ claim }) => claim.finding === "unsupported")
          ? "no evidence was found either way"
          : "monitored material cannot independently confirm this assertion";
      claims.push({
        claimId: link.occurrenceClaimId,
        status: "gap",
        reason,
      });
      continue;
    }

    const citationIds: string[] = [];
    for (const { reference, claim } of settled) {
      for (const evidence of claim.evidence) {
        if (evidence.kind !== "external") continue;
        const citationId = dossierCitationId({
          entryId: reference.entryId,
          revision: reference.revision,
          evidence,
        });
        const existing = citationById.get(citationId);
        if (existing) {
          // The ID covers entry, revision, URL and passage only. Reusing it for
          // the same source version is fine, but the rest of the provenance
          // must agree: silently keeping one set of dates would misattribute
          // the evidence.
          if (!sameProvenance(existing.evidence, evidence)) {
            throw new DossierBridgeError(
              "citation-mismatch",
              `citation ${citationId} resolves to conflicting evidence provenance`,
            );
          }
        } else {
          citationById.set(citationId, {
            citationId,
            entryId: reference.entryId,
            revision: reference.revision,
            entryArtifact: reference.artifact,
            evidence: { ...evidence },
          });
        }
        if (!citationIds.includes(citationId)) citationIds.push(citationId);
      }
    }

    if (citationIds.length === 0) {
      // Defensive: a settled finding without external evidence is a contract
      // violation, not coverage.
      throw new DossierBridgeError(
        "monitored-citation",
        `settled finding for ${link.occurrenceClaimId} has no external evidence`,
      );
    }
    claims.push({
      claimId: link.occurrenceClaimId,
      status: "covered",
      citations: citationIds,
    });
  }

  const citations = [...citationById.values()].sort((a, b) =>
    a.citationId.localeCompare(b.citationId),
  );
  const metadata = DossierMetadataSchema.parse({
    schemaVersion: 1,
    themeId: input.themeId,
    title: input.title,
    scope: input.scope,
    claims,
    citations: citations.map(toDossierCitation),
    gaps: [],
    updatedAt: input.updatedAt,
  });

  return { metadata, citations, links: [...input.links] };
}

export interface ResolvedDossier {
  metadata: DossierMetadata;
  citations: ReadonlyMap<string, DossierCitationLink>;
  links: OccurrenceClaimLink[];
}

export interface ResolveDossierInput {
  metadata: unknown;
  citations: DossierCitationLink[];
  links: OccurrenceClaimLink[];
}

/**
 * Validate a dossier together with the committed evidence it cites. Rejects
 * unknown citations, citations whose recorded text or dates disagree with the
 * committed evidence, and any citation that is not independent.
 */
export function resolveDossier(input: ResolveDossierInput): ResolvedDossier {
  const metadata = DossierMetadataSchema.parse(input.metadata);
  const citations = new Map<string, DossierCitationLink>();
  for (const link of input.citations) {
    if (citations.has(link.citationId)) {
      throw new DossierBridgeError(
        "duplicate-citation",
        `citation ${link.citationId} is supplied twice`,
      );
    }
    if (link.evidence.kind !== "external") {
      throw new DossierBridgeError(
        "monitored-citation",
        `citation ${link.citationId} is monitored material, not independent evidence`,
      );
    }
    citations.set(link.citationId, link);
  }

  const recorded = new Map(metadata.citations.map((citation) => [citation.id, citation]));
  for (const citation of metadata.citations) {
    const link = citations.get(citation.id);
    if (!link) {
      throw new DossierBridgeError(
        "unknown-citation",
        `citation ${citation.id} has no committed evidence reference`,
      );
    }
    const expected = toDossierCitation(link);
    if (
      expected.url !== citation.url ||
      expected.title !== citation.title ||
      expected.passage !== citation.passage ||
      expected.checkedAt !== citation.checkedAt ||
      (expected.sourceDate ?? null) !== (citation.sourceDate ?? null)
    ) {
      throw new DossierBridgeError(
        "citation-mismatch",
        `citation ${citation.id} does not match its committed evidence`,
      );
    }
  }
  for (const id of citations.keys()) {
    if (!recorded.has(id)) {
      throw new DossierBridgeError(
        "unknown-citation",
        `evidence ${id} is not cited by this dossier`,
      );
    }
  }

  for (const link of input.links) {
    assertClaimId(link.occurrenceClaimId, "occurrence claim");
    assertClaimId(link.normalisedClaimId, "normalised claim");
    if (!metadata.claims.some((claim) => claim.claimId === link.occurrenceClaimId)) {
      throw new DossierBridgeError(
        "unknown-claim",
        `link maps ${link.occurrenceClaimId}, which the dossier does not address`,
      );
    }
  }

  return { metadata, citations, links: [...input.links] };
}

/**
 * Evidence selected for one occurrence, in the form applicability assessment
 * and brief selection already consume. A gap yields no evidence; a covered
 * claim yields every citation it records, each with its entry and revision.
 */
export function selectedEvidenceForOccurrence(
  dossier: ResolvedDossier,
  occurrenceClaimId: string,
): SelectedEvidence[] {
  const claim = dossier.metadata.claims.find((entry) => entry.claimId === occurrenceClaimId);
  if (!claim) {
    throw new DossierBridgeError("unknown-claim", `dossier does not address ${occurrenceClaimId}`);
  }
  if (claim.status === "gap") return [];
  return claim.citations.map((id) => {
    const link = dossier.citations.get(id)!;
    return {
      entryId: link.entryId,
      revision: link.revision,
      entryArtifact: link.entryArtifact,
      evidence: { ...link.evidence },
    };
  });
}

/**
 * Research candidates for applicability assessment, built from the committed
 * revisions the dossier cites. There is no search ranking here, so `score` is
 * zero and ordering is the caller's choice.
 */
export function researchCandidates(
  dossier: ResolvedDossier,
  references: ResearchReference[],
): ResearchCandidate[] {
  const normalised = new Set(dossier.links.map((link) => link.normalisedClaimId));
  const byKey = new Map(
    references.map((reference) => [`${reference.entryId}@${reference.revision}`, reference]),
  );
  const groups = new Map<string, { entryId: string; revision: number }>();
  for (const link of dossier.citations.values()) {
    groups.set(`${link.entryId}@${link.revision}`, {
      entryId: link.entryId,
      revision: link.revision,
    });
  }
  const revisionsByEntry = new Map<string, number[]>();
  for (const { entryId, revision } of groups.values()) {
    const revisions = revisionsByEntry.get(entryId) ?? [];
    revisions.push(revision);
    revisionsByEntry.set(entryId, revisions);
  }
  for (const [entryId, revisions] of revisionsByEntry) {
    if (revisions.length > 1) {
      // One assessment run holds one state per entry: research candidates are
      // keyed by entry ID, so two revisions would collide. Re-project against
      // the revision to assess rather than guessing which one is current.
      throw new DossierBridgeError(
        "duplicate-entry",
        `dossier cites revisions ${revisions.sort((a, b) => a - b).join(", ")} of ${entryId}; assess one revision`,
      );
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { entryId, revision }]) => {
      const reference = byKey.get(key);
      if (!reference) {
        throw new DossierBridgeError(
          "unknown-entry",
          `entry ${key} cited by the dossier is not supplied`,
        );
      }
      const entry = ResearchEntrySchema.parse(reference.entry);
      return {
        entryId,
        revision,
        score: 0,
        question: entry.question,
        matches: entry.addressedClaims
          .filter((claim) => claim.claimId !== undefined && normalised.has(claim.claimId))
          .map((claim) => ({
            statement: claim.statement,
            ...(claim.claimId === undefined ? {} : { claimId: claim.claimId }),
            finding: claim.finding,
            ...(claim.unresolvedReason === undefined
              ? {}
              : { unresolvedReason: claim.unresolvedReason }),
            evidence: claim.evidence.map((evidence) => ({ ...evidence })),
          })),
        explanation: { ...entry.explanation, isEvidence: false as const },
        limitations: [...entry.limitations],
        unresolvedGaps: [...entry.unresolvedGaps],
        artifact: reference.artifact,
      } satisfies ResearchCandidate;
    });
}

/**
 * Explicit mapping from dossier citation IDs to the brief's `E<n>` IDs, so a
 * selected citation can be traced back to the same source and version.
 */
export function traceBriefCitations(
  dossier: ResolvedDossier,
  brief: Pick<DraftingBrief, "citations">,
): Array<{ citationId: string; briefCitationId: string }> {
  const byKey = new Map(
    [...dossier.citations.values()].map((link) => [citationTraceKey(link), link.citationId]),
  );
  const traced: Array<{ citationId: string; briefCitationId: string }> = [];
  for (const citation of brief.citations) {
    const citationId = byKey.get(
      citationTraceKey({
        entryId: citation.entryId,
        revision: citation.entryRevision,
        evidence: citation.evidence,
      }),
    );
    if (citationId === undefined) continue;
    traced.push({ citationId, briefCitationId: citation.citationId });
  }
  return traced.sort((a, b) => a.citationId.localeCompare(b.citationId));
}
