import { createHash } from "node:crypto";
import * as restate from "@restatedev/restate-sdk";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import {
  CorpusRefinementInputSchema,
  corpusRefinementPath,
  type CorpusRefinementInput,
  type CorpusRefinementResult,
  type CorpusRefinementOutput,
  type CorpusRefinementRejected,
  type RejectedOutput,
  type CoverageResult,
  type IdeasResult,
  type StageRef,
  type UnderlyingResult,
  groupingReport,
} from "./contracts.js";
import { checkClaimCoverage } from "./steps/check-claim-coverage.js";
import { claimsToIdeasSpec, mapClaimsToIdeas } from "./steps/map-claims-to-ideas.js";
import {
  ideasToUnderlyingSpec,
  mapIdeasToUnderlyingIdeas,
} from "./steps/map-ideas-to-underlying-ideas.js";
import { runModelStage } from "./model-step.js";
import { CorpusArtifactError, readStageArtifact, type StagePayloads } from "./artifact-schema.js";
import { UnderlyingCatalogueSchema } from "./catalogue.js";
import { collectRejectedClaims, type RejectedClaimsBatch } from "./rejected-claims.js";
import { BatchError, readBatch, saveBatch, stepInput, toBatch } from "./batch.js";
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
  const read = (ref: StageRef) => deps.artifacts.read(ref as ArtifactRef);
  /** An unusable saved artifact is terminal: retrying cannot repair it. */
  const guarded = async <T>(fn: () => T | Promise<T>): Promise<Awaited<T>> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof CorpusArtifactError || error instanceof BatchError)
        throw new restate.TerminalError(error.message);
      throw error;
    }
  };
  /** Prepare the isolated repository once, before the first write of any kind. */
  const ensureReady = async () => {
    if (!deps.ready) return;
    prepared ??= deps.ready().catch((error) => {
      prepared = undefined; // a later attempt may succeed
      throw error;
    });
    await prepared;
  };
  const stage = async <T>(
    runId: string,
    name: CorpusRefinementOutput,
    inputs: unknown,
    compute: () => Promise<T>,
  ): Promise<StageRef> => {
    await ensureReady();
    const identity = `sha256:${createHash("sha256")
      .update(JSON.stringify({ stage: name, logic: logic.version, inputs }))
      .digest("hex")}`;
    const path = corpusRefinementPath(runId, name);
    const existing = await deps.artifacts.lookup(path);
    if (existing) {
      // Validate the whole artifact before reuse (#848): run, stage, schema
      // version and payload shape, then the identity of what produced it.
      const saved = await guarded(async () =>
        readStageArtifact(await read(existing), { runId, stage: name }),
      );
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
  /** A pinned downstream read, validated against the run and stage it must be (#848). */
  const load = async <S extends CorpusRefinementOutput>(
    ref: StageRef,
    runId: string,
    stage: S,
  ): Promise<StagePayloads[S]> =>
    (await guarded(async () => readStageArtifact(await read(ref), { runId, stage }))).value;
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

        // Pinned batch input (#856): the exact records are saved before any
        // step consumes them, then read back validated. Every step works from
        // that saved version; a replay reopens it. Mode travels as a typed
        // parameter, apart from the data.
        const submitted = toBatch(input);
        // The batch is the run's first write: prepare the repository first.
        const batchRef = await ctx.run("save-batch", () =>
          guarded(async () => {
            await ensureReady();
            return plain(await saveBatch(deps.artifacts, submitted.batch));
          }),
        );
        const batch = await ctx.run("read-batch", () =>
          guarded(() => readBatch(deps.artifacts, batchRef as ArtifactRef, input.runId)),
        );
        const work = stepInput(batch, submitted.parameters);
        const batchPin = { batch: key(batchRef) };

        const coverage = await ctx.run("check-coverage", () =>
          stage(work.runId, "check-coverage", batchPin, () => logic.checkCoverage(work)),
        );
        let ideas: StageRef;
        let underlying: StageRef;
        const rejected: { stage: CorpusRefinementRejected; artifact: StageRef }[] = [];
        let rejectedClaims: StageRef | undefined;
        /** Records a mapper was given that no accepted output contains (#857). */
        const unplaced = (sent: string[], placed: string[]) => {
          const kept = new Set(placed);
          return sent.filter((id) => !kept.has(id));
        };
        if (work.mode === "archive") {
          if (!deps.provider)
            throw new restate.TerminalError(
              "corpus-refinement: archive mode needs a model provider",
            );
          // Model-backed mappings (#837): the same composed stage, each with its
          // own prompt, schema and evidence rule. The model call is its own
          // named durable step and the save is another, so a failed save never
          // repeats a recorded call. Only accepted records pass forward; issues
          // stay visible in the saved artifact.
          const provider = deps.provider;
          const coverageValue = await ctx.run("map-claims-to-ideas:input", () =>
            load(coverage, input.runId, "check-coverage"),
          );
          const mapped = await runModelStage(ctx, provider, claimsToIdeasSpec(work, coverageValue));
          ideas = await ctx.run("map-claims-to-ideas", () =>
            stage(
              input.runId,
              "map-claims-to-ideas",
              {
                ...batchPin,
                coverage: key(coverage),
                prompt: mapped.promptVersion,
                model: mapped.model,
              },
              async (): Promise<IdeasResult> => ({
                ideas: mapped.accepted,
                grouping: groupingReport(mapped.accepted),
                issues: mapped.issues,
                promptVersion: mapped.promptVersion,
                model: mapped.model,
              }),
            ),
          );
          // Named rejected output, saved before anything is routed onward (#857):
          // the claims sent but placed in no accepted idea, and the invalid
          // candidates. Built from the recorded model response, so a failed
          // save retries without a second call.
          const sentClaims = coverageValue.uncovered;
          rejected.push({
            stage: "map-claims-to-ideas-rejected",
            artifact: await ctx.run("map-claims-to-ideas-rejected", () =>
              stage(
                input.runId,
                "map-claims-to-ideas-rejected",
                { accepted: key(ideas), prompt: mapped.promptVersion, model: mapped.model },
                async (): Promise<RejectedOutput> => ({
                  from: "map-claims-to-ideas",
                  sent: sentClaims.length,
                  unplaced: unplaced(
                    sentClaims,
                    mapped.accepted.flatMap((i) => i.claimIds),
                  ),
                  issues: mapped.issues,
                }),
              ),
            ),
          });
          // Only the accepted output is routed to the second mapper.
          const ideasValue = await ctx.run("map-ideas-to-underlying:input", () =>
            load(ideas, input.runId, "map-claims-to-ideas"),
          );
          // The reviewed catalogue, read at its pinned version only (#852).
          // The workflow never writes it: proposals are saved for review.
          const pinned = input.catalogue;
          const catalogue = pinned
            ? await ctx.run("map-ideas-to-underlying:catalogue", async () => {
                // A store failure is retried; a bad pinned version never changes,
                // so malformed JSON or the wrong shape is terminal.
                const text = await deps.artifacts.read(pinned as ArtifactRef);
                let raw: unknown;
                try {
                  raw = JSON.parse(text);
                } catch {
                  raw = undefined;
                }
                const parsed = UnderlyingCatalogueSchema.safeParse(raw);
                if (!parsed.success)
                  throw new restate.TerminalError(
                    "corpus-refinement: the pinned catalogue is not a valid catalogue",
                  );
                return parsed.data;
              })
            : undefined;
          const grouped = await runModelStage(
            ctx,
            provider,
            ideasToUnderlyingSpec(ideasValue, catalogue),
          );
          underlying = await ctx.run("map-ideas-to-underlying", () =>
            stage(
              input.runId,
              "map-ideas-to-underlying",
              {
                ideas: key(ideas),
                // Only when pinned, so runs without a catalogue keep their identity.
                ...(pinned ? { catalogue: key(pinned) } : {}),
                prompt: grouped.promptVersion,
                model: grouped.model,
              },
              async (): Promise<UnderlyingResult> => ({
                underlying: grouped.accepted,
                ...(pinned ? { catalogue: pinned } : {}),
                issues: grouped.issues,
                promptVersion: grouped.promptVersion,
                model: grouped.model,
              }),
            ),
          );
          rejected.push({
            stage: "map-ideas-to-underlying-rejected",
            artifact: await ctx.run("map-ideas-to-underlying-rejected", () =>
              stage(
                input.runId,
                "map-ideas-to-underlying-rejected",
                { accepted: key(underlying), prompt: grouped.promptVersion, model: grouped.model },
                async (): Promise<RejectedOutput> => ({
                  from: "map-ideas-to-underlying",
                  sent: ideasValue.ideas.length,
                  unplaced: unplaced(
                    ideasValue.ideas.map((i) => i.id),
                    grouped.accepted.flatMap((g) => g.ideaIds),
                  ),
                  issues: grouped.issues,
                }),
              ),
            ),
          });
          // Reject handler (#855): one named save of the run's rejected claims,
          // built from the saved rejected outputs by exact reference.
          const groupedIdeas = grouped.accepted.flatMap((g) => g.ideaIds);
          rejectedClaims = await ctx.run("rejected-claims", () =>
            stage(
              input.runId,
              "rejected-claims",
              {
                batch: key(batchRef),
                ideas: key(ideas),
                rejected: rejected.map((r) => key(r.artifact)),
              },
              async (): Promise<RejectedClaimsBatch> =>
                collectRejectedClaims({
                  runId: input.runId,
                  claims: work.claims,
                  ideas: ideasValue,
                  grouped: groupedIdeas,
                  rejected: await Promise.all(
                    rejected.map(async (r) => ({
                      output: r.artifact,
                      value: await load(r.artifact, input.runId, r.stage),
                    })),
                  ),
                  sources: {
                    batch: plain(batchRef as ArtifactRef),
                    ideas,
                    rejected: rejected.map((r) => r.artifact),
                  },
                }),
            ),
          );
        } else {
          ideas = await ctx.run("map-claims-to-ideas", () =>
            stage(
              input.runId,
              "map-claims-to-ideas",
              { ...batchPin, coverage: key(coverage) },
              async () =>
                logic.mapClaimsToIdeas(work, await load(coverage, work.runId, "check-coverage")),
            ),
          );
          underlying = await ctx.run("map-ideas-to-underlying", () =>
            stage(input.runId, "map-ideas-to-underlying", { ideas: key(ideas) }, async () =>
              logic.mapIdeasToUnderlying(await load(ideas, input.runId, "map-claims-to-ideas")),
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
          ...(rejected.length ? { rejected } : {}),
          ...(rejectedClaims ? { rejectedClaims } : {}),
        };
      },
    },
  });
}
export type CorpusRefinementApi = ReturnType<typeof corpusRefinementWorkflow>;
