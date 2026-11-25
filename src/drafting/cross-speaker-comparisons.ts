import { createHash } from "node:crypto";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { ClaimOccurrence } from "../analysis/claim-occurrence.js";
import {
  DEFAULT_PARALLEL_PROMPT,
  findCrossSpeakerParallels,
  PARALLEL_NOTE,
  type CrossSpeakerResult,
} from "../analysis/cross-speaker-parallels.js";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import { writeOnce } from "../research/job.js";
import {
  claimOccurrences,
  MAX_HISTORY_CLAIMS,
  type SpeakerComparisonDeps,
} from "./speaker-comparisons.js";

/**
 * Pinned cross-speaker parallels for the unattended essay (#388).
 *
 * For each accepted claim of the post (bounded), finds other verified speakers
 * making the same specific claim (#371) and saves one write-once record per
 * claim under `comparisons/<publication>/<post>/`, in the comparison shape
 * the writer package already reads (#176, #370). Each earlier passage carries
 * its speaker, so the essay can attribute it to the right person.
 *
 * A parallel says that two people made the same claim; it does not say who
 * originated it, or that either is true. It is `cites` only when the other
 * passage itself credits the current speaker verbatim. Every claim gets a
 * record, including no-match and failed searches, for diagnostics; records
 * without parallels add nothing to the package.
 */

function toRecord(
  occurrence: ClaimOccurrence,
  result: CrossSpeakerResult | { outcome: "search-failed" },
  provider: ExtractionModelProvider,
) {
  const parallels = "parallels" in result ? result.parallels : [];
  const findings = parallels.map((p) => {
    // Exact offsets in the archived source text; a quote whose whitespace
    // differs from the stored passage cites the whole passage instead.
    const at = p.passage.indexOf(p.quote);
    const quote = at >= 0 ? p.quote : p.passage;
    const start = p.span.start + Math.max(at, 0);
    return {
      kind: p.attribution === "cites" ? "cross-speaker-cites" : "cross-speaker-parallel",
      relation: p.relation,
      // The model's own description of the difference: generated, never evidence.
      explanation: { text: p.difference, isEvidence: false as const },
      uncertainty: "medium" as const,
      current: {
        quote: occurrence.passage,
        artifact: occurrence.artifact,
        sourceVersion: occurrence.sourceVersion,
      },
      earlier: [
        {
          postId: p.postId,
          publishedAt: p.publishedAt,
          url: p.url,
          quote,
          artifact: p.artifact,
          start,
          end: start + quote.length,
          speaker: p.speaker.name,
          ...(p.citationQuote ? { citationQuote: p.citationQuote } : {}),
        },
      ],
    };
  });
  return {
    schemaVersion: 1,
    kind: "cross-speaker",
    status: findings.length > 0 ? "parallels" : result.outcome,
    claimId: occurrence.claimId,
    occurrenceId: occurrence.occurrenceId,
    ...("speaker" in result && result.speaker ? { speaker: result.speaker } : {}),
    note: PARALLEL_NOTE,
    search: {
      outcome: result.outcome,
      ...("diagnostics" in result ? { diagnostics: result.diagnostics } : {}),
    },
    findings,
    modelVersion: provider.modelVersion,
    promptVersion: DEFAULT_PARALLEL_PROMPT.version,
  };
}

/** Find each accepted claim's cross-speaker parallels; returns every saved record. */
export async function saveCrossSpeakerComparisons(input: {
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
          "cross-speaker",
          // The whole occurrence: a re-extraction may keep the occurrence ID
          // for a changed statement or speaker.
          occurrence,
          input.claimResult.commit,
          input.claimResult.path,
          input.deps.provider.modelVersion,
          DEFAULT_PARALLEL_PROMPT.version,
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    const path = `comparisons/${occurrence.publicationId}/${occurrence.postId}/cross-${key}.json`;
    const existing = await input.content.lookup(path);
    if (existing) {
      refs.push(existing);
      continue;
    }
    let result: CrossSpeakerResult | { outcome: "search-failed" };
    try {
      result = await findCrossSpeakerParallels({
        search: input.deps.search,
        occurrence,
        provider: input.deps.provider,
        ...(input.deps.index ? { index: input.deps.index } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      // Parallels are optional context: a failed search is recorded, never fatal.
      result = { outcome: "search-failed" };
    }
    refs.push(
      await writeOnce(input.content, path, toRecord(occurrence, result, input.deps.provider)),
    );
  }
  return refs;
}
