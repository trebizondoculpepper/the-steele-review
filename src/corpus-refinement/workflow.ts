import { createHash } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import {
  CorpusRefinementInputSchema,
  corpusRefinementPath,
  type CorpusRefinementInput,
  type CorpusRefinementResult,
  type CorpusRefinementStage,
  type CoverageResult,
  type IdeasResult,
  type StageRef,
  type UnderlyingResult,
} from "./contracts.js";
import { checkClaimCoverage } from "./steps/check-claim-coverage.js";
import { claimsToIdeasSpec, mapClaimsToIdeas } from "./steps/map-claims-to-ideas.js";
import {
  ideasToUnderlyingSpec,
  mapIdeasToUnderlyingIdeas,
} from "./steps/map-ideas-to-underlying-ideas.js";
import { runModelStage } from "./model-step.js";
import type { ExtractionModelProvider } from "../analysis/extraction.js";

/**
 * Corpus Refinement workflow (#830): wires the three stages together and owns
 * recovery. Each stage reads the exact versioned artifact of the previous
 * stage, saves its own artifact once at a path derived from the run ID and
 * stage name, and hands that exact reference forward. Independent of article
 * production; the prototype stages are deterministic stubs.
 */

/** Typed handoffs between the three stages. */
export interface CorpusRefinementLogic {
  /** Version of the stage logic; part of every artifact's identity. */
  version: string;
  checkCoverage(input: CorpusRefinementInput): Promise<CoverageResult>;
  mapClaimsToIdeas(input: CorpusRefinementInput, coverage: CoverageResult): Promise<IdeasResult>;
  mapIdeasToUnderlying(ideas: IdeasResult): Promise<UnderlyingResult>;
}

/** The deterministic prototype stages: no model calls. */
export const STUB_CORPUS_REFINEMENT: CorpusRefinementLogic = {
  version: "corpus-refinement-stub-v1",
  checkCoverage: checkClaimCoverage,
  mapClaimsToIdeas,
  mapIdeasToUnderlying: mapIdeasToUnderlyingIdeas,
};

const plain = (ref: ArtifactRef): StageRef => ({
  repository: ref.repository,
  commit: ref.commit,
  path: ref.path,
  sha256: ref.sha256,
});

export function corpusRefinementWorkflow(deps: {
  artifacts: Pick<GitArtifactStore, "write" | "read" | "lookup">;
  logic?: CorpusRefinementLogic;
  /**
   * When present, both mapping stages are model-backed through the shared
   * composable stage (#837); otherwise the deterministic stubs run.
   */
  provider?: ExtractionModelProvider;
  /** Prepares the isolated repository once, before the first save. */
  ready?: () => Promise<unknown>;
}) {
  const logic = deps.logic ?? STUB_CORPUS_REFINEMENT;
  let prepared: Promise<unknown> | undefined;
  /** Saves once: a replayed stage finds its own saved artifact and reuses it. */
  /**
   * Saves a stage once. The artifact records the identity of what produced it
   * (stage, logic version, exact inputs). A saved artifact is reused only when
   * that identity matches; a run ID reused with other inputs or changed logic
   * fails instead of silently returning a stale result.
   */
  const stage = async <T>(
    runId: string,
    name: CorpusRefinementStage,
    inputs: unknown,
    compute: () => Promise<T>,
  ): Promise<StageRef> => {
    if (deps.ready) {
      prepared ??= deps.ready().catch((error) => {
        prepared = undefined; // a later attempt may succeed
        throw error;
      });
      await prepared;
    }
    const identity = `sha256:${createHash("sha256")
      .update(JSON.stringify({ stage: name, logic: logic.version, inputs }))
      .digest("hex")}`;
    const path = corpusRefinementPath(runId, name);
    const existing = await deps.artifacts.lookup(path);
    if (existing) {
      const saved = JSON.parse(await deps.artifacts.read(existing)) as { identity?: string };
      if (saved.identity !== identity)
        throw new restate.TerminalError(
          `corpus-refinement: ${name} for ${runId} was saved from different inputs or logic`,
        );
      return plain(existing);
    }
    const value = await compute();
    return plain(
      await deps.artifacts.write(
        path,
        JSON.stringify({ schemaVersion: 1, stage: name, runId, identity, value }, null, 2),
      ),
    );
  };
  const load = async <T>(ref: StageRef): Promise<T> =>
    (JSON.parse(await deps.artifacts.read(ref as ArtifactRef)) as { value: T }).value;
  /** The exact version of a handed-off artifact, for the next stage's identity. */
  const key = (ref: StageRef) => [ref.repository, ref.commit, ref.path, ref.sha256];

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

        const coverage = await ctx.run("check-coverage", () =>
          stage(input.runId, "check-coverage", input, () => logic.checkCoverage(input)),
        );
        let ideas: StageRef;
        let underlying: StageRef;
        if (deps.provider) {
          // Model-backed mappings (#837): the same composed stage, each with its
          // own prompt, schema and evidence rule. The model call is its own
          // named durable step and the save is another, so a failed save never
          // repeats a recorded call. Only accepted records pass forward; issues
          // stay visible in the saved artifact.
          const provider = deps.provider;
          const coverageValue = await ctx.run("map-claims-to-ideas:input", () =>
            load<CoverageResult>(coverage),
          );
          const mapped = await runModelStage(
            ctx,
            provider,
            claimsToIdeasSpec(input, coverageValue),
          );
          ideas = await ctx.run("map-claims-to-ideas", () =>
            stage(
              input.runId,
              "map-claims-to-ideas",
              { input, coverage: key(coverage), prompt: mapped.promptVersion, model: mapped.model },
              async (): Promise<IdeasResult> => ({
                ideas: mapped.accepted,
                issues: mapped.issues,
                promptVersion: mapped.promptVersion,
                model: mapped.model,
              }),
            ),
          );
          const ideasValue = await ctx.run("map-ideas-to-underlying:input", () =>
            load<IdeasResult>(ideas),
          );
          const grouped = await runModelStage(ctx, provider, ideasToUnderlyingSpec(ideasValue));
          underlying = await ctx.run("map-ideas-to-underlying", () =>
            stage(
              input.runId,
              "map-ideas-to-underlying",
              { ideas: key(ideas), prompt: grouped.promptVersion, model: grouped.model },
              async (): Promise<UnderlyingResult> => ({
                underlying: grouped.accepted,
                issues: grouped.issues,
                promptVersion: grouped.promptVersion,
                model: grouped.model,
              }),
            ),
          );
        } else {
          ideas = await ctx.run("map-claims-to-ideas", () =>
            stage(
              input.runId,
              "map-claims-to-ideas",
              { input, coverage: key(coverage) },
              async () => logic.mapClaimsToIdeas(input, await load<CoverageResult>(coverage)),
            ),
          );
          underlying = await ctx.run("map-ideas-to-underlying", () =>
            stage(input.runId, "map-ideas-to-underlying", { ideas: key(ideas) }, async () =>
              logic.mapIdeasToUnderlying(await load<IdeasResult>(ideas)),
            ),
          );
        }
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
