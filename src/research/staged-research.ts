import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { WebAdapterError } from "../controllers/research-web.js";
import { isCreditExhausted } from "../observability/provider-condition.js";
import { acceptedAssemblyReader, assembleResearch } from "./assemble-research.js";
import {
  acceptedDiscoveryReader,
  retrieveCitations,
  saveCitationInventory,
  type RetrievalLimits,
} from "./citation-inventory.js";
import { discoveryFromAdapterReport } from "./discovery-data.js";
import { captureResearchDiscovery, ResearchDiscoveryError } from "./discovery.js";
import type { PageFetcher } from "./gap-research.js";
import {
  finishResearchJob,
  researchJobPath,
  ResearchResultSchema,
  researchJobId,
  type ResearchRequest,
  type ResearchResult,
} from "./job.js";
import type { CommissionedJob } from "./librarian.js";
import { RESEARCH_PROMPT_VERSION, researchPrompt } from "./runner.js";
import type { SonarClient } from "./sonar.js";

/**
 * Staged research (#593, under #210): the named, recoverable stages that
 * replace one coarse research step. Each function is one durable step the
 * Restate `Research` service runs with its own `ctx.run`, so a replay reuses
 * every completed stage and a failed URL never restarts discovery:
 *
 *   discover  → durable discovery artifact (#590)
 *   inventory → saved URL inventory (#591)
 *   retrieve  → independent per-URL outcomes (#591), bounded rounds
 *   assemble  → manifest/result + completion event (#592)
 *
 * Git (artifacts) owns documents and exact refs; the state controller keeps
 * its narrow transactions; vendor access stays behind the existing Sonar and
 * page-fetch controllers. Provider failure and credit exhaustion end as a
 * failed result, never as an evidence gap.
 */

export interface StagedResearchDeps {
  artifacts: GitArtifactStore;
  operations: OperationStore;
  sonar: SonarClient;
  fetcher: PageFetcher;
  owner: string;
  limits: RetrievalLimits;
  now?: () => Date;
}

/** Plain, serialisable artifact reference passed between durable steps. */
export interface StageRef {
  repository: string;
  commit: string;
  path: string;
  sha256: string;
}
const plain = (r: ArtifactRef): StageRef => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.sha256,
});

export type DiscoverOutcome =
  | { kind: "discovered"; discovery: StageRef }
  | { kind: "failed"; failure: NonNullable<ResearchResult["failure"]> };

/** Stage 1: deep discovery, retained durably before interpretation. */
export async function discoverStage(
  deps: StagedResearchDeps,
  request: ResearchRequest,
  signal: AbortSignal = AbortSignal.timeout(deps.sonar.settings?.timeoutMs ?? 600_000),
): Promise<DiscoverOutcome> {
  try {
    const captured = await captureResearchDiscovery({
      artifacts: deps.artifacts,
      operations: deps.operations,
      request,
      owner: deps.owner,
      processor: {
        version: "research-discovery-v1",
        model: deps.sonar.model,
        promptVersion: RESEARCH_PROMPT_VERSION,
        parameters:
          deps.sonar.discoveryParameters ??
          (deps.sonar.settings
            ? {
                timeoutMs: deps.sonar.settings.timeoutMs,
                maxOutputTokens: deps.sonar.settings.maxOutputTokens,
              }
            : {}),
      },
      invoke: async (capture) =>
        discoveryFromAdapterReport(
          await deps.sonar.research(researchPrompt(request), signal, capture),
        ),
      ...(deps.now ? { now: deps.now } : {}),
    });
    return { kind: "discovered", discovery: plain(captured.ref) };
  } catch (error) {
    // Credit exhaustion is not a verdict on the evidence (#407).
    if (isCreditExhausted(error)) return { kind: "failed", failure: "budget-exceeded" };
    if (error instanceof WebAdapterError && error.code === "credit-exhausted")
      return { kind: "failed", failure: "budget-exceeded" };
    if (error instanceof ResearchDiscoveryError) {
      switch (error.code) {
        case "credit-exhausted":
          return { kind: "failed", failure: "budget-exceeded" };
        case "invalid-report":
        case "quarantined":
          return { kind: "failed", failure: "invalid-report" };
        case "busy":
        case "archive-failed":
          throw error; // transient storage/fence: Restate retries the step
        default:
          // Provider failure (uncertain, rate-limited, unauthorised, bad request).
          return { kind: "failed", failure: "provider-error" };
      }
    }
    return { kind: "failed", failure: "provider-error" };
  }
}

/** Stage 2: the saved citation inventory of that exact discovery. */
export async function inventoryStage(
  deps: StagedResearchDeps,
  discovery: StageRef,
): Promise<StageRef> {
  const { ref } = await saveCitationInventory({
    artifacts: deps.artifacts,
    discovery,
    readDiscovery: acceptedDiscoveryReader(deps.artifacts, deps.operations),
  });
  return plain(ref);
}

/** Stage 3: one bounded retrieval round; returns how many keys remain retryable. */
export async function retrieveStage(
  deps: StagedResearchDeps,
  inventory: StageRef,
): Promise<{ retryable: number; creditExhausted?: true }> {
  try {
    const out = await retrieveCitations({
      artifacts: deps.artifacts,
      inventory,
      fetcher: deps.fetcher,
      limits: deps.limits,
    });
    return { retryable: out.retryable.length };
  } catch (error) {
    // Exhausted credit is an operational block, not an evidence gap: report it
    // so the job ends recoverably; saved discovery and downloads are kept.
    if (
      isCreditExhausted(error) ||
      (error instanceof WebAdapterError && error.code === "credit-exhausted")
    )
      return { retryable: 0, creditExhausted: true };
    throw error;
  }
}

/** Stage 4: assemble and record completion; the job the librarian pins. */
export async function assembleStage(
  deps: StagedResearchDeps,
  discovery: StageRef,
  inventory: StageRef,
): Promise<CommissionedJob> {
  const out = await assembleResearch({
    artifacts: deps.artifacts,
    operations: deps.operations,
    discovery,
    inventory,
    read: acceptedAssemblyReader(deps.artifacts, deps.operations),
    owner: deps.owner,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const result = ResearchResultSchema.parse(JSON.parse(await deps.artifacts.read(out.result)));
  return { jobId: out.jobId, status: "finished", result, resultRef: plain(out.result) };
}

/** A failed job from a stage that ended without evidence (provider failure or credit). */
export function failedJob(
  request: ResearchRequest,
  failure: NonNullable<ResearchResult["failure"]>,
  now: () => Date = () => new Date(),
): CommissionedJob {
  return {
    jobId: researchJobId(request),
    status: "finished",
    result: ResearchResultSchema.parse({
      schemaVersion: 1,
      jobId: researchJobId(request),
      outcome: "failed",
      failure,
      finishedAt: now().toISOString(),
    }),
  };
}

/**
 * Finish a staged job that ended without evidence. Terminal failures
 * (provider error, invalid report) are persisted write-once with their
 * `research.completed` outbox event, exactly as the legacy runner does.
 * Credit exhaustion is not final: it is returned unpersisted so the same
 * job can run once credit is restored, and coverage stops the article run.
 */
export async function finishFailedStage(
  deps: Pick<StagedResearchDeps, "artifacts" | "operations" | "now">,
  request: ResearchRequest,
  failure: NonNullable<ResearchResult["failure"]>,
): Promise<CommissionedJob> {
  if (failure === "budget-exceeded") return failedJob(request, failure, deps.now);
  const jobId = researchJobId(request);
  const out = await finishResearchJob({
    artifacts: deps.artifacts,
    operations: deps.operations,
    jobId,
    outcome: "failed",
    failure,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return { jobId, status: "finished", result: out.result, resultRef: plain(out.resultRef) };
}

/** A job whose terminal result is already saved is reused, never rerun. */
export async function existingJob(
  deps: Pick<StagedResearchDeps, "artifacts" | "operations">,
  request: ResearchRequest,
): Promise<CommissionedJob | null> {
  const jobId = researchJobId(request);
  const ref = await deps.artifacts.lookup(researchJobPath(jobId, "result"));
  if (!ref) return null;
  const saved = ResearchResultSchema.parse(JSON.parse(await deps.artifacts.read(ref)));
  // Adopt through the completion helper, which records any missing
  // completion event before the saved result is reused.
  const out = await finishResearchJob({
    artifacts: deps.artifacts,
    operations: deps.operations,
    jobId,
    outcome: saved.outcome,
  });
  return { jobId, status: "finished", result: out.result, resultRef: plain(out.resultRef) };
}

/** Bound on retrieval rounds for transient failures within one invocation. */
export const MAX_RETRIEVAL_ROUNDS = 3;
