import { z } from "zod";
import type { Claim } from "../analysis/claim.js";
import type { PassageRetriever, RetrievedPassage, RetrievalResult } from "./passage-retrieval.js";

/**
 * Earlier coverage for an extracted claim: passages from the same
 * publication, published strictly before the claim's source post, excluding
 * the source post itself (every version of it).
 *
 * Uses the hybrid keyword/semantic retriever (#31), keeps the best passage
 * per earlier post, and returns them oldest first. Posts without a
 * publication date cannot be placed in the chronology and are excluded and
 * counted. The result states its coverage limits: retrieval only finds what
 * the corpus holds and what the query terms or embeddings reach, so an empty
 * result does not show that the topic was never covered.
 */

export const MAX_EARLIER = 20;

export interface EarlierCoverageRequest {
  claim: Pick<Claim, "statement" | "sourceVersion">;
  publicationId: string;
  /** The claim's source post, excluded from results. */
  sourcePostId: string;
  /** Observed publication time of the source post; results are strictly earlier. */
  sourcePublishedAt: string;
  limit?: number;
}

export interface EarlierPassage extends RetrievedPassage {
  publishedAt: string;
}

export interface EarlierCoverage {
  /** Oldest first, at most one passage per earlier post. */
  passages: EarlierPassage[];
  limitations: {
    mode: RetrievalResult["mode"];
    semanticUnavailable?: RetrievalResult["semanticUnavailable"];
    /** Candidates dropped because their post has no publication date. */
    excludedUndated: number;
    /** Always present: absence of results is not evidence of absence. */
    note: string;
  };
}

const RequestSchema = z.object({
  claim: z
    .object({ statement: z.string().trim().min(1), sourceVersion: z.string().min(1) })
    .loose(),
  publicationId: z.string().min(1),
  sourcePostId: z.string().min(1),
  sourcePublishedAt: z.iso.datetime({ offset: true }),
  limit: z.number().int().min(1).max(MAX_EARLIER).optional(),
});

export const COVERAGE_NOTE =
  "Results reflect only the captured corpus and what keyword or semantic retrieval reached; finding nothing does not show the topic was never covered.";

export async function findEarlierCoverage(
  retriever: Pick<PassageRetriever, "retrieve">,
  request: EarlierCoverageRequest,
): Promise<EarlierCoverage> {
  const r = RequestSchema.parse(request);
  const limit = r.limit ?? 10;
  const sourceTime = Date.parse(r.sourcePublishedAt);
  const result = await retriever.retrieve({
    text: r.claim.statement.slice(0, 2000),
    publicationId: r.publicationId,
    to: r.sourcePublishedAt,
    limit: Math.min(MAX_EARLIER, limit * 2),
  });

  let excludedUndated = 0;
  const bestPerPost = new Map<string, EarlierPassage>();
  for (const p of result.passages) {
    if (p.publicationId !== r.publicationId || p.postId === r.sourcePostId) continue;
    if (!p.publishedAt) {
      excludedUndated++;
      continue;
    }
    if (Date.parse(p.publishedAt) >= sourceTime) continue; // strictly earlier only
    const current = bestPerPost.get(p.postId);
    if (!current || p.signals.fused > current.signals.fused) {
      bestPerPost.set(p.postId, p as EarlierPassage);
    }
  }
  const passages = [...bestPerPost.values()]
    .sort((a, b) => b.signals.fused - a.signals.fused)
    .slice(0, limit)
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  return {
    passages,
    limitations: {
      mode: result.mode,
      ...(result.semanticUnavailable ? { semanticUnavailable: result.semanticUnavailable } : {}),
      excludedUndated,
      note: COVERAGE_NOTE,
    },
  };
}
