import type { CorpusRefinementInput, CoverageResult } from "../contracts.js";

/** Stage 1 (#830): which claims in the batch are covered. Deterministic stub. */
export async function checkClaimCoverage(input: CorpusRefinementInput): Promise<CoverageResult> {
  // Even-indexed claims count as covered.
  const ids = input.claims.map((c) => c.id);
  return {
    covered: ids.filter((_, i) => i % 2 === 0),
    uncovered: ids.filter((_, i) => i % 2 === 1),
  };
}
