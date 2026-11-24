import { z } from "zod";
import { loadStagePrompt, quotedIn, type ModelStageSpec } from "../model-step.js";
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

/** One candidate idea, as the model must return it (#837). */
export const IdeaRecordSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    statement: z.string().min(1).max(1000),
    claimIds: z.array(z.string().min(1).max(200)).min(1).max(200),
    evidence: z
      .array(z.object({ claimId: z.string().min(1), quote: z.string().min(1).max(2000) }).strict())
      .min(1)
      .max(50),
  })
  .strict();
export type IdeaRecord = z.infer<typeof IdeaRecordSchema>;

/**
 * The claims-to-ideas mapping as a model-backed stage (#837): its prompt,
 * schema and evidence rule. Only uncovered claims are sent; an idea may only
 * cite those claims, and every quotation must appear in the cited claim.
 */
export function claimsToIdeasSpec(
  input: CorpusRefinementInput,
  coverage: CoverageResult,
): ModelStageSpec<IdeaRecord> {
  const claims = input.claims.filter((c) => coverage.uncovered.includes(c.id));
  const byId = new Map(claims.map((c) => [c.id, c.statement]));
  return {
    stage: "map-claims-to-ideas",
    prompt: loadStagePrompt("map-claims-to-ideas"),
    input: { claims },
    listKey: "ideas",
    schema: IdeaRecordSchema,
    check: (idea) => {
      const unknown = idea.claimIds.find((id) => !byId.has(id));
      if (unknown) return `unknown-claim:${unknown}`;
      for (const e of idea.evidence) {
        if (!idea.claimIds.includes(e.claimId)) return `evidence-outside-idea:${e.claimId}`;
        if (!quotedIn(e.quote, byId.get(e.claimId)!)) return `quote-not-in-claim:${e.claimId}`;
      }
      return undefined;
    },
  };
}
