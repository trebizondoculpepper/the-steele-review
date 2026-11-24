import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";

/**
 * Corpus Refinement prototype (#830): a Restate workflow independent of
 * article production. Three named stages run in order:
 *
 * 1. check-coverage: which claims in the batch are covered;
 * 2. map-claims-to-ideas: group claims under ideas;
 * 3. map-ideas-to-underlying: group ideas under underlying ideas.
 *
 * Each stage reads the exact versioned artifact of the previous stage, saves
 * its own artifact at a path derived from the run ID and stage name, and
 * hands that exact reference forward. Stage logic is injected; the prototype
 * uses deterministic stubs and makes no model calls.
 */

export const CORPUS_REFINEMENT_STAGES = [
  "check-coverage",
  "map-claims-to-ideas",
  "map-ideas-to-underlying",
] as const;
export type CorpusRefinementStage = (typeof CORPUS_REFINEMENT_STAGES)[number];

const RunId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);

export const CorpusRefinementInputSchema = z
  .object({
    runId: RunId,
    claims: z
      .array(
        z
          .object({ id: z.string().min(1).max(200), statement: z.string().min(1).max(2000) })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type CorpusRefinementInput = z.infer<typeof CorpusRefinementInputSchema>;

/** A saved stage artifact, by exact version. */
export interface StageRef {
  repository: string;
  commit: string;
  path: string;
  sha256: string;
}

export interface CoverageResult {
  covered: string[];
  uncovered: string[];
}
export interface IdeasResult {
  ideas: { id: string; claimIds: string[] }[];
}
export interface UnderlyingResult {
  underlying: { id: string; ideaIds: string[] }[];
}

/** Typed handoffs between the three stages. */
export interface CorpusRefinementLogic {
  checkCoverage(input: CorpusRefinementInput): Promise<CoverageResult>;
  mapClaimsToIdeas(input: CorpusRefinementInput, coverage: CoverageResult): Promise<IdeasResult>;
  mapIdeasToUnderlying(ideas: IdeasResult): Promise<UnderlyingResult>;
}

/** Deterministic stubs: no model calls, the same output for the same input. */
export const STUB_CORPUS_REFINEMENT: CorpusRefinementLogic = {
  async checkCoverage(input) {
    // Even-indexed claims count as covered.
    const ids = input.claims.map((c) => c.id);
    return {
      covered: ids.filter((_, i) => i % 2 === 0),
      uncovered: ids.filter((_, i) => i % 2 === 1),
    };
  },
  async mapClaimsToIdeas(input, coverage) {
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
  },
  async mapIdeasToUnderlying(ideas) {
    return { underlying: [{ id: "underlying-all", ideaIds: ideas.ideas.map((i) => i.id) }] };
  },
};

/** Where one stage's artifact lives, derived only from the run ID and stage name. */
export const corpusRefinementPath = (runId: string, stage: CorpusRefinementStage) =>
  `corpus-refinement/${runId}/${stage}.json`;

export interface CorpusRefinementResult {
  runId: string;
  stages: { stage: CorpusRefinementStage; artifact: StageRef }[];
}

const plain = (ref: ArtifactRef): StageRef => ({
  repository: ref.repository,
  commit: ref.commit,
  path: ref.path,
  sha256: ref.sha256,
});

export function corpusRefinementWorkflow(deps: {
  artifacts: Pick<GitArtifactStore, "write" | "read" | "lookup">;
  logic?: CorpusRefinementLogic;
  /** Prepares the isolated repository once, before the first save. */
  ready?: () => Promise<unknown>;
}) {
  const logic = deps.logic ?? STUB_CORPUS_REFINEMENT;
  let prepared: Promise<unknown> | undefined;
  /** Saves once: a replayed stage finds its own saved artifact and reuses it. */
  const save = async (runId: string, stage: CorpusRefinementStage, value: unknown) => {
    if (deps.ready) {
      prepared ??= deps.ready().catch((error) => {
        prepared = undefined; // a later attempt may succeed
        throw error;
      });
      await prepared;
    }
    const path = corpusRefinementPath(runId, stage);
    const existing = await deps.artifacts.lookup(path);
    if (existing) return plain(existing);
    return plain(await deps.artifacts.write(path, JSON.stringify(value, null, 2)));
  };
  const load = async <T>(ref: StageRef): Promise<T> =>
    JSON.parse(await deps.artifacts.read(ref as ArtifactRef)) as T;

  return restate.workflow({
    name: "CorpusRefinement",
    handlers: {
      run: async (
        ctx: restate.WorkflowContext,
        raw: CorpusRefinementInput,
      ): Promise<CorpusRefinementResult> => {
        const parsed = CorpusRefinementInputSchema.safeParse(raw);
        if (!parsed.success) throw new restate.TerminalError("corpus-refinement: invalid input");
        const input = parsed.data;
        if (ctx.key !== input.runId)
          throw new restate.TerminalError("corpus-refinement: run ID does not match the key");

        const coverage = await ctx.run("check-coverage", async () =>
          save(input.runId, "check-coverage", await logic.checkCoverage(input)),
        );
        const ideas = await ctx.run("map-claims-to-ideas", async () =>
          save(
            input.runId,
            "map-claims-to-ideas",
            await logic.mapClaimsToIdeas(input, await load<CoverageResult>(coverage)),
          ),
        );
        const underlying = await ctx.run("map-ideas-to-underlying", async () =>
          save(
            input.runId,
            "map-ideas-to-underlying",
            await logic.mapIdeasToUnderlying(await load<IdeasResult>(ideas)),
          ),
        );
        return {
          runId: input.runId,
          stages: [
            { stage: "check-coverage", artifact: coverage },
            { stage: "map-claims-to-ideas", artifact: ideas },
            { stage: "map-ideas-to-underlying", artifact: underlying },
          ],
        };
      },
    },
  });
}
export type CorpusRefinementApi = ReturnType<typeof corpusRefinementWorkflow>;

/** A bounded synthetic batch for the prototype CLI and tests. */
export function syntheticBatch(runId: string, size: number): CorpusRefinementInput {
  const words = ["masts", "towers", "vaccines", "satellites", "meters"];
  return {
    runId,
    claims: Array.from({ length: Math.max(1, Math.min(200, size)) }, (_, i) => ({
      id: `claim-${String(i).padStart(3, "0")}`,
      statement: `${words[i % words.length]} synthetic claim ${i}`,
    })),
  };
}
