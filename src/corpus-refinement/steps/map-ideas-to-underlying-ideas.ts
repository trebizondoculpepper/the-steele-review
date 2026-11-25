import { z } from "zod";
import { loadStagePrompt, type ModelStageSpec } from "../model-step.js";
import type { IdeasResult, UnderlyingResult } from "../contracts.js";
import type { UnderlyingCatalogue } from "../catalogue.js";

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
export type UnderlyingRecord = z.infer<typeof UnderlyingRecordSchema> & {
  match?: z.infer<typeof MatchSchema>;
};

const CatalogueRef = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
/** The proposed relation to the reviewed catalogue (#852). */
const MatchSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("reuse"), catalogueId: CatalogueRef }).strict(),
  z.object({ decision: z.literal("new") }).strict(),
  z
    .object({
      decision: z.literal("uncertain"),
      candidates: z.array(CatalogueRef).min(1).max(5),
    })
    .strict(),
]);
/** With a catalogue, every group must say how it relates to it. */
export const UnderlyingWithMatchSchema = UnderlyingRecordSchema.extend({
  match: MatchSchema,
}).strict();

/**
 * The ideas-to-underlying-ideas mapping as a model-backed stage (#837): only
 * the ideas the previous stage accepted are sent, and a group may only cite
 * those ideas, with no idea in two groups.
 */
export function ideasToUnderlyingSpec(
  ideas: IdeasResult,
  catalogue?: UnderlyingCatalogue,
): ModelStageSpec<UnderlyingRecord> {
  const known = new Set(ideas.ideas.map((i) => i.id));
  const entries = new Set(catalogue?.entries.map((e) => e.id) ?? []);
  // A catalogue entry may be reused by one group only: two groups reusing it
  // are one proposition split in two.
  const reused = new Set<string>();
  const used = new Set<string>();
  // Accepted group IDs: one ID must name one proposition.
  const groups = new Set<string>();
  return {
    stage: "map-ideas-to-underlying",
    prompt: loadStagePrompt("map-ideas-to-underlying-ideas"),
    input: {
      ideas: ideas.ideas.map((i) => ({ id: i.id, statement: i.statement ?? i.id })),
      ...(catalogue ? { catalogue: catalogue.entries } : {}),
    },
    listKey: "underlying",
    schema: catalogue ? UnderlyingWithMatchSchema : UnderlyingRecordSchema,
    check: (group) => {
      const catalogueIssue = catalogue ? checkMatch(group, entries, reused) : undefined;
      if (catalogueIssue) return catalogueIssue;
      // At least two distinct ideas: repeating one ID is not a shared proposition.
      if (new Set(group.ideaIds).size !== group.ideaIds.length)
        return `repeated-idea:${group.ideaIds.find((id, i) => group.ideaIds.indexOf(id) !== i)}`;
      const unknown = group.ideaIds.find((id) => !known.has(id));
      if (unknown) return `unknown-idea:${unknown}`;
      const repeated = group.ideaIds.find((id) => used.has(id));
      if (repeated) return `idea-in-two-groups:${repeated}`;
      if (groups.has(group.id)) return `duplicate-group:${group.id}`;
      groups.add(group.id);
      if (group.match?.decision === "reuse") reused.add(group.match.catalogueId);
      for (const id of group.ideaIds) used.add(id);
      return undefined;
    },
  };
}

/**
 * Catalogue rules (#852): a reuse names one existing entry and keeps its
 * stable ID; a new idea must not take an existing entry's ID; an uncertain
 * match names only existing entries.
 */
function checkMatch(
  group: UnderlyingRecord,
  entries: Set<string>,
  reused: Set<string>,
): string | undefined {
  const match = group.match;
  if (!match) return "schema:match";
  if (match.decision === "reuse") {
    if (!entries.has(match.catalogueId)) return `unknown-catalogue-id:${match.catalogueId}`;
    if (group.id !== match.catalogueId) return `reuse-id-mismatch:${group.id}`;
    if (reused.has(match.catalogueId)) return `catalogue-id-in-two-groups:${match.catalogueId}`;
    return undefined;
  }
  if (match.decision === "new") {
    return entries.has(group.id) ? `new-id-in-catalogue:${group.id}` : undefined;
  }
  const unknown = match.candidates.find((id) => !entries.has(id));
  if (unknown) return `unknown-catalogue-id:${unknown}`;
  if (new Set(match.candidates).size !== match.candidates.length) return "repeated-candidate";
  return entries.has(group.id) ? `new-id-in-catalogue:${group.id}` : undefined;
}
