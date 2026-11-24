import type { CorpusRefinementInput, CoverageResult, IdeasResult } from "../contracts.js";

/**
 * Stage 2 (#830): group uncovered claims under ideas. Deterministic stub; the
 * model-backed version composes the shared model step (#835 to #837).
 */
export async function mapClaimsToIdeas(
  input: CorpusRefinementInput,
  coverage: CoverageResult,
): Promise<IdeasResult> {
  // One idea per first word of the statement, uncovered claims only.
  const groups = new Map<string, string[]>();
  for (const claim of input.claims) {
    if (!coverage.uncovered.includes(claim.id)) continue;
    const key = (claim.statement.trim().split(/\s+/)[0] ?? "other").toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), claim.id]);
  }
  return {
    ideas: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, claimIds]) => ({ id: `idea-${key}`, claimIds })),
  };
}
