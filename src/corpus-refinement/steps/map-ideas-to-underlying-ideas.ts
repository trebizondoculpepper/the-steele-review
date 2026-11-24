import type { IdeasResult, UnderlyingResult } from "../contracts.js";

/**
 * Stage 3 (#830): group ideas under underlying ideas. Deterministic stub; the
 * model-backed version composes the shared model step (#835 to #837).
 */
export async function mapIdeasToUnderlyingIdeas(ideas: IdeasResult): Promise<UnderlyingResult> {
  return { underlying: [{ id: "underlying-all", ideaIds: ideas.ideas.map((i) => i.id) }] };
}
