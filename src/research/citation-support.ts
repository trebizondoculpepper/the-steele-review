import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { ModelProviderError } from "../controllers/openrouter.js";
import {
  CitationInventorySchema,
  readCitationSnapshot,
  RetrievalOutcomeSchema,
} from "./citation-inventory.js";
import { writeOnce, type ResearchRequest } from "./job.js";
import { findingsFor, type SupportJudge } from "./runner.js";

/**
 * Support assessment for staged research (#593): the handoff from retrieved
 * documents to evidence that article coverage needs. One archived source is
 * judged per durable step, exactly as the whole-job runner judges it:
 *
 * - A passage counts only when the judge returns it, it names a finding of
 *   this request, and it appears verbatim in the archived snapshot.
 * - The claimant's own pages (monitored hosts) stay `unverified` and are
 *   labelled `monitored-source`, never independent support.
 * - The judgement is saved write-once beside the retrieval outcome, bound to
 *   the exact snapshot it judged, so assembly and replays reuse it.
 * - Credit exhaustion stops the job recoverably; any other judge failure
 *   leaves the source `not-checked` (unsaved, so a later attempt may judge it).
 */

const Ref = z
  .object({ repository: z.string(), commit: z.string(), path: z.string(), hash: z.string() })
  .strict();

export const CitationSupportSchema = z
  .object({
    schemaVersion: z.literal(1),
    retrievalId: z.string(),
    retrievalKey: z.string(),
    snapshot: Ref,
    support: z.enum(["supported", "unverified"]),
    /** Prompt identity of the judge that produced this verdict; "none" for the host-only decision. */
    judge: z.string().max(200),
    monitored: z.boolean(),
    sourceType: z.string().max(100).optional(),
    rationale: z.string().max(2000).optional(),
    passages: z
      .array(z.object({ claimRecordId: z.string(), passage: z.string().max(4000) }).strict())
      .max(50),
  })
  .strict();
export type CitationSupport = z.infer<typeof CitationSupportSchema>;

const normalise = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

/** The judge identity a verdict is keyed by; "none" when no judge is configured. */
export const judgeIdentity = (judge?: SupportJudge) =>
  judge?.identity ?? (judge ? "unidentified" : "none");

/** One verdict per source per judge identity: a prompt change never reuses an old verdict. */
export const supportPath = (inventory: ArtifactRef, retrievalId: string, identity: string) =>
  `${inventory.path.replace(/\/inventory\.json$/, "")}/support/${retrievalId}/${createHash("sha256").update(identity).digest("hex").slice(0, 32)}.json`;

export type SupportStep =
  | { kind: "judged"; support: CitationSupport["support"] }
  | { kind: "not-archived" }
  | { kind: "not-checked" }
  | { kind: "credit-exhausted" };

export async function judgeCitationSupport(input: {
  artifacts: GitArtifactStore;
  inventory: ArtifactRef;
  retrievalId: string;
  request: ResearchRequest;
  /** The discovery report: support is judged for what it says, citing this source. */
  report: string;
  judge?: SupportJudge;
  monitoredHosts?: string[];
  signal?: AbortSignal;
}): Promise<SupportStep> {
  const identity = judgeIdentity(input.judge);
  const path = supportPath(input.inventory, input.retrievalId, identity);
  const saved = await input.artifacts.lookup(path);
  if (saved) {
    const s = CitationSupportSchema.parse(JSON.parse(await input.artifacts.read(saved)));
    if (s.judge === identity) return { kind: "judged", support: s.support };
  }
  const dir = input.inventory.path.replace(/\/inventory\.json$/, "");
  const outcomeRef = await input.artifacts.lookup(`${dir}/retrievals/${input.retrievalId}.json`);
  if (!outcomeRef) return { kind: "not-archived" };
  const outcome = RetrievalOutcomeSchema.parse(JSON.parse(await input.artifacts.read(outcomeRef)));
  if (outcome.status !== "archived" || !outcome.snapshot) return { kind: "not-archived" };
  const inventory = CitationInventorySchema.parse(
    JSON.parse(await input.artifacts.read(input.inventory)),
  );
  const entry = inventory.entries.find((e) => e.retrievalId === input.retrievalId);
  if (!entry?.retrievalKey || entry.retrievalKey !== outcome.retrievalKey) {
    return { kind: "not-archived" };
  }
  const snapshot = await readCitationSnapshot(input.artifacts, outcome.snapshot);
  if (snapshot.retrievalKey !== entry.retrievalKey) return { kind: "not-archived" };

  const host = new URL(entry.retrievalKey).hostname.toLowerCase();
  const monitored = (input.monitoredHosts ?? []).some(
    (h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`),
  );
  const record = async (
    fields: Pick<CitationSupport, "support" | "passages" | "sourceType" | "rationale">,
  ) => {
    await writeOnce(
      input.artifacts,
      path,
      CitationSupportSchema.parse({
        schemaVersion: 1,
        retrievalId: input.retrievalId,
        retrievalKey: entry.retrievalKey,
        snapshot: outcome.snapshot,
        monitored,
        judge: identity,
        ...fields,
      }),
    );
    return { kind: "judged" as const, support: fields.support };
  };
  if (!input.judge) {
    // Without a judge only the monitored-source decision is certain.
    return monitored ? record({ support: "unverified", passages: [] }) : { kind: "not-checked" };
  }
  const findings = findingsFor(input.request);
  const findingIds = new Set(findings.map((f) => f.id));
  try {
    const judgement = await input.judge.judge(
      { findings, report: input.report, url: entry.retrievalKey, source: snapshot.text },
      input.signal ?? AbortSignal.timeout(120_000),
    );
    const source = normalise(snapshot.text);
    const passages = judgement.passages
      .filter((p) => findingIds.has(p.findingId) && p.passage.trim().length > 0)
      .filter((p) => source.includes(normalise(p.passage)))
      .slice(0, 50)
      .map((p) => ({ claimRecordId: p.findingId, passage: p.passage.trim().slice(0, 4000) }));
    const proposed = judgement.sourceType?.slice(0, 100);
    return record({
      support: !monitored && passages.length > 0 ? "supported" : "unverified",
      passages,
      ...(proposed && proposed !== "monitored-source" ? { sourceType: proposed } : {}),
      ...(judgement.rationale ? { rationale: judgement.rationale.slice(0, 2000) } : {}),
    });
  } catch (error) {
    if (error instanceof ModelProviderError && error.code === "credit-exhausted") {
      return { kind: "credit-exhausted" };
    }
    return { kind: "not-checked" };
  }
}
