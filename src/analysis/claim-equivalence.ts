import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { ExtractionModelProvider, ExtractionPrompt } from "./extraction.js";
import { ClaimRecordSchema, type ClaimRecord } from "./grounded-claims.js";

/**
 * Equivalent-claim reuse (#145).
 *
 * Claim records from #144 are keyed by strict normalised text, so the same
 * assertion worded differently starts as two records. This step proposes
 * candidate earlier claims, asks the model to compare meaning, and merges
 * only on a confident, validated match:
 *
 * - Candidates are retrieved lexically from existing claim records (bounded).
 *   Retrieval only proposes; similarity never proves equivalence or truth.
 *   (The embedding retrieval components can replace this ranking where
 *   configured; no other vector store is introduced.)
 * - The model must name one of the offered candidate IDs and say the
 *   speaker context, quantities, dates, qualifiers and negation agree. Any
 *   uncertainty, or a non-high confidence, keeps the claims separate.
 * - The decision, with its comparison evidence and model/prompt versions, is
 *   saved immutably before any record changes, and reused on rerun.
 * - A merge adds the new record's occurrences (each still under its own
 *   source identity) to the earlier, canonical record, which keeps its ID and
 *   so its research links; the newer record then redirects to it. Both steps
 *   are idempotent, so repeated runs never inflate occurrence counts.
 */

export const DEFAULT_EQUIVALENCE_PROMPT: ExtractionPrompt = {
  version: "claim-equivalence-v1",
  instructions: [
    "Decide whether a new claim asserts the same thing as one of the candidate earlier claims.",
    "They are equivalent only if a correction of one would equally correct the other: the same subject, the same direction, matching quantities, dates, scope and qualifiers, and no difference in negation. Different wording alone does not matter.",
    "A shared topic, a related claim, a stronger or weaker version, or a negation is NOT equivalent.",
    'Use the source passages, posts and speakers: claims that depend on context (who "we" or "our" refers to, which place or period) are only equivalent if that context matches.',
    "Do not judge whether either claim is true.",
    'Respond with JSON only: {"match": "<candidate id>" | null, "confidence": "high"|"medium"|"low", "reason": "<one or two sentences comparing them>"}.',
  ].join("\n"),
};

export const MAX_CANDIDATES = 10;
export const MAX_SCANNED_RECORDS = 2_000;

const RECORD_PATH = /^claims\/claim-[0-9a-f]{32}\.json$/;

const DecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    record: z.string(),
    statement: z.string(),
    candidates: z.array(z.object({ id: z.string(), statement: z.string() }).strict()),
    match: z.string().nullable(),
    confidence: z.enum(["high", "medium", "low"]).nullable(),
    reason: z.string(),
    modelVersion: z.string(),
    promptVersion: z.string(),
    decidedAt: z.string(),
  })
  .strict();
export type EquivalenceDecision = z.infer<typeof DecisionSchema>;

const ModelOutputSchema = z
  .object({
    match: z.string().nullable(),
    confidence: z.enum(["high", "medium", "low"]),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export type EquivalenceOutcome =
  | {
      status: "merged";
      record: string;
      canonical: string;
      decision: EquivalenceDecision;
      reused: boolean;
    }
  | { status: "separate"; record: string; decision?: EquivalenceDecision; reused: boolean }
  | { status: "already-merged"; record: string; canonical: string }
  | {
      status: "failed";
      record: string;
      reason: "provider-failed" | "malformed-output" | "not-found";
    };

const words = (text: string) =>
  new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}%.<>+-]+/u)
      .filter((w) => w.length > 3),
  );

async function readRecord(
  artifacts: GitArtifactStore,
  id: string,
): Promise<{ record: ClaimRecord; ref: ArtifactRef } | undefined> {
  const ref = await artifacts.lookup(`claims/${id}.json`);
  if (!ref) return undefined;
  return { record: ClaimRecordSchema.parse(JSON.parse(await artifacts.read(ref))), ref };
}

/** Bounded lexical candidate retrieval over canonical claim records. */
export async function candidateClaims(
  artifacts: GitArtifactStore,
  record: ClaimRecord,
  limit = MAX_CANDIDATES,
): Promise<ClaimRecord[]> {
  const paths = (await artifacts.list("claims", MAX_SCANNED_RECORDS)).filter((p) =>
    RECORD_PATH.test(p),
  );
  const target = words(record.statement);
  const scored: Array<{ r: ClaimRecord; s: number }> = [];
  for (const path of paths) {
    const id = path.slice("claims/".length, -".json".length);
    if (id === record.id) continue;
    const found = await readRecord(artifacts, id);
    if (!found || found.record.canonical) continue;
    let s = 0;
    for (const w of words(found.record.statement)) if (target.has(w)) s++;
    if (s > 0) scored.push({ r: found.record, s });
  }
  return scored
    .sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id))
    .slice(0, limit)
    .map((x) => x.r);
}

function decisionPath(
  recordId: string,
  modelVersion: string,
  promptVersion: string,
  candidateIds: string[],
) {
  const key = createHash("sha256")
    .update(JSON.stringify([modelVersion, promptVersion, [...candidateIds].sort()]))
    .digest("hex")
    .slice(0, 16);
  return `claim-equivalence/${recordId}-${key}.json`;
}

function parseOutput(raw: string) {
  let body = raw.trim();
  const fence = /^```(?:json)?\n([\s\S]*)\n```$/.exec(body);
  if (fence) body = fence[1];
  try {
    const parsed = ModelOutputSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function revise(
  artifacts: GitArtifactStore,
  id: string,
  change: (r: ClaimRecord) => ClaimRecord | undefined,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const found = await readRecord(artifacts, id);
    if (!found) throw new Error("claim record missing");
    const next = change(found.record);
    if (!next) return;
    try {
      await artifacts.revise(
        `claims/${id}.json`,
        `${JSON.stringify(ClaimRecordSchema.parse(next), null, 2)}\n`,
        found.ref.sha256,
      );
      return;
    } catch (error) {
      const code = error instanceof ArtifactStoreError ? error.code : undefined;
      if ((code === "stale-revision" || code === "concurrent-update") && attempt < 5) continue;
      throw error;
    }
  }
}

/**
 * Merge `from` into canonical `into`. The redirect is saved first, so any
 * occurrence extracted afterwards goes straight to the canonical record;
 * then every occurrence the source holds is copied across. Both steps are
 * idempotent, and a partially completed merge is finished by a rerun.
 */
export async function mergeClaimRecords(
  artifacts: GitArtifactStore,
  from: string,
  into: string,
  decision: EquivalenceDecision,
): Promise<void> {
  await revise(artifacts, from, (r) =>
    r.canonical === into ? undefined : { ...r, canonical: into },
  );
  await copyOccurrences(artifacts, from, into, decision);
}

async function copyOccurrences(
  artifacts: GitArtifactStore,
  from: string,
  into: string,
  decision: Pick<EquivalenceDecision, "reason" | "modelVersion" | "promptVersion" | "decidedAt">,
): Promise<void> {
  const source = await readRecord(artifacts, from);
  if (!source) throw new Error("claim record missing");
  await revise(artifacts, into, (target) => {
    const known = new Set(target.occurrences.map((o) => o.occurrenceId));
    const added = source.record.occurrences.filter((o) => !known.has(o.occurrenceId));
    const themeIds = [...new Set([...target.themeIds, ...source.record.themeIds])].sort();
    const already = (target.equivalences ?? []).some((e) => e.record === from);
    if (added.length === 0 && already && themeIds.length === target.themeIds.length)
      return undefined;
    return {
      ...target,
      themeIds,
      occurrences: [...target.occurrences, ...added],
      equivalences: already
        ? target.equivalences
        : [
            ...(target.equivalences ?? []),
            {
              record: from,
              statement: source.record.statement,
              reason: decision.reason,
              modelVersion: decision.modelVersion,
              promptVersion: decision.promptVersion,
              decidedAt: decision.decidedAt,
            },
          ],
    };
  });
}

/** Follow redirects to the current canonical record (bounded). */
async function canonicalOf(artifacts: GitArtifactStore, id: string): Promise<string> {
  let current = id;
  for (let hops = 0; hops < 20; hops++) {
    const next = (await readRecord(artifacts, current))?.record.canonical;
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

export async function resolveClaimEquivalence(input: {
  provider: ExtractionModelProvider;
  prompt?: ExtractionPrompt;
  artifacts: GitArtifactStore;
  recordId: string;
  now?: () => Date;
  maxAttempts?: number;
  signal?: AbortSignal;
}): Promise<EquivalenceOutcome> {
  const prompt = input.prompt ?? DEFAULT_EQUIVALENCE_PROMPT;
  const found = await readRecord(input.artifacts, input.recordId);
  if (!found) return { status: "failed", record: input.recordId, reason: "not-found" };
  const { record } = found;
  if (record.canonical) {
    // Finish a merge interrupted after its redirect (idempotent).
    const canonical = await canonicalOf(input.artifacts, record.canonical);
    await copyOccurrences(input.artifacts, record.id, canonical, {
      reason: "merge completed after interruption",
      modelVersion: input.provider.modelVersion,
      promptVersion: prompt.version,
      decidedAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    return { status: "already-merged", record: record.id, canonical };
  }

  const candidates = await candidateClaims(input.artifacts, record);
  if (candidates.length === 0) return { status: "separate", record: record.id, reused: false };
  const path = decisionPath(
    record.id,
    input.provider.modelVersion,
    prompt.version,
    candidates.map((c) => c.id),
  );

  let decision: EquivalenceDecision;
  const existing = await input.artifacts.lookup(path);
  const reused = existing !== undefined;
  if (existing) {
    decision = DecisionSchema.parse(JSON.parse(await input.artifacts.read(existing)));
  } else {
    // Statements alone can hide context ("our revenue"): include the exact
    // source passages, posts and speaker kinds for each side.
    const context = (r: ClaimRecord) => ({
      id: r.id,
      statement: r.statement,
      occurrences: r.occurrences.slice(0, 3).map((o) => ({
        post: `${o.publicationId}/${o.postId}`,
        speaker: o.speakerKind,
        passage: o.passage,
      })),
    });
    const user = JSON.stringify({ newClaim: context(record), candidates: candidates.map(context) });
    let output: z.infer<typeof ModelOutputSchema> | undefined;
    let failure: "provider-failed" | "malformed-output" = "provider-failed";
    const attempts = Math.max(1, Math.min(input.maxAttempts ?? 2, 5));
    for (let i = 0; i < attempts && !output; i++) {
      let raw: string;
      try {
        raw = await input.provider.complete(
          { system: prompt.instructions, user, maxOutputChars: 8_000 },
          input.signal ?? new AbortController().signal,
        );
      } catch {
        failure = "provider-failed";
        continue;
      }
      output = parseOutput(raw);
      if (!output) failure = "malformed-output";
    }
    if (!output) return { status: "failed", record: record.id, reason: failure };
    const offered = new Set(candidates.map((c) => c.id));
    // Conservative: only a high-confidence match to an offered candidate merges.
    const match =
      output.match !== null && offered.has(output.match) && output.confidence === "high"
        ? output.match
        : null;
    decision = DecisionSchema.parse({
      schemaVersion: 1,
      record: record.id,
      statement: record.statement,
      candidates: candidates.map((c) => ({ id: c.id, statement: c.statement })),
      match,
      confidence: output.confidence,
      reason: output.reason,
      modelVersion: input.provider.modelVersion,
      promptVersion: prompt.version,
      decidedAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    try {
      await input.artifacts.write(path, `${JSON.stringify(decision, null, 2)}\n`);
    } catch (error) {
      if (!(error instanceof ArtifactStoreError) || error.code !== "immutable-conflict")
        throw error;
      const winner = await input.artifacts.lookup(path);
      if (!winner) throw error;
      decision = DecisionSchema.parse(JSON.parse(await input.artifacts.read(winner)));
    }
  }

  if (decision.match === null) return { status: "separate", record: record.id, decision, reused };
  // Resolve both sides to their current canonical records, then always merge
  // the larger ID into the smaller. Concurrent reciprocal decisions (A→B and
  // B→A) therefore agree on one direction and can never form a cycle.
  const mine = await canonicalOf(input.artifacts, record.id);
  const theirs = await canonicalOf(input.artifacts, decision.match);
  if (mine === theirs) return { status: "already-merged", record: record.id, canonical: mine };
  const [canonical, merged] = mine < theirs ? [mine, theirs] : [theirs, mine];
  await mergeClaimRecords(input.artifacts, merged, canonical, decision);
  return { status: "merged", record: record.id, canonical, decision, reused };
}
