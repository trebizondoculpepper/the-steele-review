import { createHash } from "node:crypto";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { ClaimOccurrenceSchema, type ClaimOccurrence } from "../analysis/claim-occurrence.js";
import type { OccurrenceSearchPort } from "../analysis/claim-timeline.js";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import {
  DEFAULT_SAME_SPEAKER_PROMPT,
  findSameSpeakerHistory,
  type SameSpeakerHistory,
} from "../analysis/same-speaker-history.js";
import {
  DEFAULT_EVOLUTION_PROMPT,
  explainSpeakerEvolution,
  type SpeakerEvolution,
} from "../analysis/speaker-evolution.js";
import { writeOnce } from "../research/job.js";

/**
 * Pinned same-speaker comparisons for the unattended essay (#370).
 *
 * For each accepted claim of the post (bounded), finds earlier examples from
 * the same verified speaker (#368) and explains how the claim repeats or
 * evolves (#369). One record per claim is saved write-once under
 * `comparisons/<publication>/<post>/`, in the shape the writer package
 * already reads for historical comparisons (#176), so it is pinned into the
 * package by exact reference like any other comparison.
 *
 * Every claim gets a record, including no-match and failed searches, so a run
 * keeps its search result for diagnostics. Records without earlier passages
 * add nothing to the package's history; the article then says nothing about
 * missing history. A record is keyed by the claim occurrence and the model
 * and prompt versions, and reused on rerun, so a replayed workflow step sees
 * the same history even if the index has changed since.
 */

export const MAX_HISTORY_CLAIMS = 5;

export interface SpeakerComparisonDeps {
  search: OccurrenceSearchPort;
  provider: ExtractionModelProvider;
  index?: string;
}

function claimOccurrences(raw: string): ClaimOccurrence[] {
  const record = ClaimExtractionRecordSchema.parse(JSON.parse(raw));
  const out: ClaimOccurrence[] = [];
  for (const c of record.claims) {
    if (c.kind !== "assertion" || c.classification !== "themed") continue;
    const o = ClaimOccurrenceSchema.safeParse(c.occurrence);
    if (o.success) out.push(o.data);
  }
  return out;
}

function toRecord(
  occurrence: ClaimOccurrence,
  history: SameSpeakerHistory | { outcome: "search-failed" },
  evolution: SpeakerEvolution | undefined,
  provider: ExtractionModelProvider,
) {
  const matches = "matches" in history ? history.matches : [];
  const byId = new Map(matches.map((m) => [m.occurrenceId, m]));
  const findings = (evolution?.findings ?? []).map((f) => {
    const m = byId.get(f.earlier.occurrenceId)!;
    // Exact offsets in the archived source text; a quote whose whitespace
    // differs from the stored passage cites the whole passage instead.
    const at = m.passage.indexOf(f.earlier.quote);
    const quote = at >= 0 ? f.earlier.quote : m.passage;
    const start = m.span.start + Math.max(at, 0);
    return {
      kind: f.kind,
      aspects: f.aspects,
      explanation: f.explanation,
      uncertainty: f.uncertainty,
      ...(f.circumstancesChecked ? { changedCircumstances: f.circumstancesChecked } : {}),
      current: {
        quote: occurrence.passage.includes(f.current.quote) ? f.current.quote : occurrence.passage,
        artifact: occurrence.artifact,
        sourceVersion: occurrence.sourceVersion,
      },
      earlier: [
        {
          postId: m.postId,
          publishedAt: m.publishedAt,
          url: m.url,
          quote,
          artifact: m.artifact,
          start,
          end: start + quote.length,
        },
      ],
    };
  });
  return {
    schemaVersion: 1,
    kind: "speaker-history",
    status: evolution?.status ?? (history.outcome === "search-failed" ? "failed" : "no-history"),
    claimId: occurrence.claimId,
    occurrenceId: occurrence.occurrenceId,
    ...("speaker" in history && history.speaker ? { speaker: history.speaker } : {}),
    pattern: evolution?.pattern ?? "none",
    search: {
      outcome: history.outcome,
      ...("diagnostics" in history ? { diagnostics: history.diagnostics } : {}),
    },
    findings,
    rejected: evolution?.rejected ?? [],
    modelVersion: provider.modelVersion,
    promptVersion: `${DEFAULT_SAME_SPEAKER_PROMPT.version}+${DEFAULT_EVOLUTION_PROMPT.version}`,
  };
}

/** Compare each accepted claim with the speaker's history; returns every saved record. */
export async function saveSpeakerComparisons(input: {
  content: GitArtifactStore;
  claimResult: ArtifactRef;
  deps: SpeakerComparisonDeps;
  maxClaims?: number;
  signal?: AbortSignal;
}): Promise<ArtifactRef[]> {
  const occurrences = claimOccurrences(await input.content.read(input.claimResult)).slice(
    0,
    input.maxClaims ?? MAX_HISTORY_CLAIMS,
  );
  const refs: ArtifactRef[] = [];
  for (const occurrence of occurrences) {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          occurrence.occurrenceId,
          input.deps.provider.modelVersion,
          DEFAULT_SAME_SPEAKER_PROMPT.version,
          DEFAULT_EVOLUTION_PROMPT.version,
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    const path = `comparisons/${occurrence.publicationId}/${occurrence.postId}/speaker-${key}.json`;
    const existing = await input.content.lookup(path);
    if (existing) {
      refs.push(existing);
      continue;
    }
    let history: SameSpeakerHistory | { outcome: "search-failed" };
    try {
      history = await findSameSpeakerHistory({
        search: input.deps.search,
        occurrence,
        provider: input.deps.provider,
        ...(input.deps.index ? { index: input.deps.index } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      // History is optional context: a failed search is recorded, never fatal.
      history = { outcome: "search-failed" };
    }
    const evolution =
      "matches" in history && history.matches.length > 0
        ? await explainSpeakerEvolution({
            occurrence,
            history,
            provider: input.deps.provider,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        : undefined;
    const ref = await writeOnce(
      input.content,
      path,
      toRecord(occurrence, history, evolution, input.deps.provider),
    );
    refs.push(ref);
  }
  return refs;
}
