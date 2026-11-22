import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { researchJobId } from "./job.js";
import {
  prepareRetainedResearch,
  readAcceptedResearchRecovery,
} from "./retained-research-source.js";
import { runResearchJob, type SupportJudge, type RunnerLimits } from "./runner.js";
import type { PageFetcher } from "./gap-research.js";

const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

/** Explicit saved-response continuation. There is deliberately no discovery/provider capability. */
export async function recoverRetainedResearch(input: {
  artifacts: GitArtifactStore;
  operations: OperationStore;
  discovery: ArtifactRef;
  failedResult: ArtifactRef;
  owner: string;
  fetcher: PageFetcher;
  judge: SupportJudge;
  monitoredHosts?: readonly string[];
  limits?: RunnerLimits;
  leaseMs?: number;
}) {
  const prepared = await prepareRetainedResearch(input);
  const jobId = researchJobId(prepared.request);
  const existing = input.operations.researchRecovery(prepared.originalJobId);
  if (existing && existing.jobId !== jobId) throw new Error("retained-research-recovery-conflict");
  const claim = input.operations.claim(
    `retained-research:${prepared.originalJobId}:${jobId}`,
    input.owner,
    input.leaseMs ?? 30 * 60_000,
    3,
  );
  if (claim.kind === "busy") return { status: "busy" as const, jobId };
  if (claim.kind === "completed") {
    const saved = await readAcceptedResearchRecovery({
      ...input,
      request: prepared.retained.request,
    });
    if (!saved || saved.binding.jobId !== jobId)
      throw new Error("retained-research-acceptance-mismatch");
    return { status: "recovered" as const, ...saved, reused: true };
  }
  if (claim.kind !== "claimed") throw new Error("retained-research-recovery-exhausted");
  try {
    const out = await runResearchJob({ ...input, request: prepared.request });
    if (out.status === "busy" || out.result.outcome === "failed") {
      input.operations.yieldClaim(claim.claim);
      return {
        status: "incomplete" as const,
        jobId,
        ...(out.status === "finished" ? { result: out.result } : {}),
      };
    }
    const result = await input.artifacts.lookup(`research-jobs/${jobId}/result.json`);
    if (!result || out.result.outcome !== "complete-with-gaps")
      throw new Error("invalid-retained-research-result");
    const binding = {
      version: "retained-length-limit-v1" as const,
      originalJobId: prepared.originalJobId,
      jobId,
      discovery: ref(input.discovery),
      failedResult: ref(input.failedResult),
      result: ref(result),
    };
    input.operations.completeResearchRecovery(claim.claim, binding);
    const saved = await readAcceptedResearchRecovery({
      ...input,
      request: prepared.retained.request,
    });
    if (!saved) throw new Error("retained-research-not-accepted");
    return { status: "recovered" as const, ...saved, reused: false };
  } catch (error) {
    try {
      input.operations.yieldClaim(claim.claim);
    } catch {
      /* Lost owners cannot release another attempt. */
    }
    throw error;
  }
}
