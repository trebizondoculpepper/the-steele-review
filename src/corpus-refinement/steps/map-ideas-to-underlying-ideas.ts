import { z } from "zod";
import { loadStagePrompt, type ModelStageSpec } from "../model-step.js";
import type { IdeasResult, UnderlyingResult } from "../contracts.js";

/**
 * Stage 3 (#830): group ideas under underlying ideas. Deterministic stub; the
 * model-backed version composes the shared model step (#835 to #837).
 */
export async function mapIdeasToUnderlyingIdeas(ideas: IdeasResult): Promise<UnderlyingResult> {
  return { underlying: [{ id: "underlying-all", ideaIds: ideas.ideas.map((i) => i.id) }] };
}

/** One candidate underlying idea, as the model must return it (#837). */
export const UnderlyingRecordSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    statement: z.string().min(1).max(1000),
    ideaIds: z.array(z.string().min(1).max(200)).min(2).max(200),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
export type UnderlyingRecord = z.infer<typeof UnderlyingRecordSchema>;

/**
 * The ideas-to-underlying-ideas mapping as a model-backed stage (#837): only
 * the ideas the previous stage accepted are sent, and a group may only cite
 * those ideas, with no idea in two groups.
 */
export function ideasToUnderlyingSpec(ideas: IdeasResult): ModelStageSpec<UnderlyingRecord> {
  const known = new Set(ideas.ideas.map((i) => i.id));
  const used = new Set<string>();
  return {
    stage: "map-ideas-to-underlying",
    prompt: loadStagePrompt("map-ideas-to-underlying-ideas"),
    input: { ideas: ideas.ideas.map((i) => ({ id: i.id, statement: i.statement ?? i.id })) },
    listKey: "underlying",
    schema: UnderlyingRecordSchema,
    check: (group) => {
      const unknown = group.ideaIds.find((id) => !known.has(id));
      if (unknown) return `unknown-idea:${unknown}`;
      const repeated = group.ideaIds.find((id) => used.has(id));
      if (repeated) return `idea-in-two-groups:${repeated}`;
      for (const id of group.ideaIds) used.add(id);
      return undefined;
    },
  };
}
