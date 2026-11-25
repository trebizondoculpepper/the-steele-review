import type { CorpusRefinementInput, CoverageResult } from "../contracts.js";

/** Stage 1 (#830): which claims in the batch are covered. Deterministic stub. */
export async function checkClaimCoverage(input: CorpusRefinementInput): Promise<CoverageResult> {
  if (input.mode === "archive") {
    // Coverage from the saved librarian records, carried on each claim (#832).
    return {
      covered: input.claims.filter((c) => c.covered === true).map((c) => c.id),
      uncovered: input.claims.filter((c) => c.covered !== true).map((c) => c.id),
      included: input.claims.map((c) => c.id),
      deferred: input.deferred ?? [],
    };
  }
  // Even-indexed claims count as covered.
  const ids = input.claims.map((c) => c.id);
  return {
    covered: ids.filter((_, i) => i % 2 === 0),
    uncovered: ids.filter((_, i) => i % 2 === 1),
  };
}
