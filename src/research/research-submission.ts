import * as clients from "@restatedev/restate-sdk-clients";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { ResearchServiceApi } from "../workflow/article-run.js";
import { RESEARCH_SCOPE, researchCallKey } from "../workflow/article-run.js";
import {
  ResearchResultSchema,
  researchJobId,
  researchJobPath,
  type ResearchRequest,
  type ResearchResult,
} from "./job.js";
import type { CommissionedJob } from "./librarian.js";

/**
 * Manual research as a typed submission (#594, under #210). The CLI no longer
 * runs research in its own process: it submits the validated request to the
 * same Restate `Research` service, scope and shared `sonar` concurrency limit
 * that article research uses, and returns durable identifiers at once.
 *
 * - Idempotent: the call key is the stable job ID plus an explicit
 *   reprocessing generation, so repeating a submission attaches to the same
 *   invocation instead of buying another discovery.
 * - Saved work first: a job whose terminal result is already saved (including
 *   legacy standalone manual jobs) is reported, never silently resubmitted.
 * - Waiting is optional and detached: `wait` attaches to the invocation by
 *   its ID; a disconnect leaves the invocation running in Restate.
 */

/** The narrow ingress surface the submission needs; faked in tests. */
export interface ResearchIngressPort {
  send(
    handler: "run" | "runStaged",
    request: ResearchRequest,
    idempotencyKey: string,
  ): Promise<{ invocationId: string; status: "Accepted" | "PreviouslyAccepted" }>;
  /** Attach to an accepted invocation and wait for its job. */
  attach(invocationId: string, signal: AbortSignal): Promise<CommissionedJob>;
}

export function restateResearchIngress(ingressUrl: string): ResearchIngressPort {
  const ingress = clients.connect({ url: ingressUrl });
  const sends = new Map<string, clients.Send<CommissionedJob>>();
  return {
    async send(handler, request, idempotencyKey) {
      const client = ingress
        .scope(RESEARCH_SCOPE)
        .serviceSendClient<ResearchServiceApi>({ name: "Research" });
      const send = (await client[handler](
        request,
        clients.rpc.sendOpts({
          idempotencyKey,
          limitKey: "sonar",
          signal: AbortSignal.timeout(10_000),
        } as never),
      )) as clients.Send<CommissionedJob>;
      sends.set(send.invocationId, send);
      return { invocationId: send.invocationId, status: send.status };
    },
    async attach(invocationId, signal) {
      const send =
        sends.get(invocationId) ??
        ({ invocationId, status: "Accepted" } as clients.Send<CommissionedJob>);
      return Promise.race([
        ingress.result(send),
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("wait-timeout")), { once: true }),
        ),
      ]);
    },
  };
}

export type SubmissionOutcome =
  | {
      kind: "existing";
      jobId: string;
      result: ResearchResult;
      resultRef: ArtifactRef;
    }
  | {
      kind: "submitted";
      jobId: string;
      invocationId: string;
      /** True when Restate already had this exact submission. */
      repeated: boolean;
      handler: "run" | "runStaged";
      inspect?: string;
      job?: CommissionedJob;
      /** Set when `wait` ended before the job finished; the invocation keeps running. */
      waitEnded?: "timeout";
    };

export async function submitManualResearch(input: {
  ingress: ResearchIngressPort;
  artifacts: Pick<GitArtifactStore, "lookup" | "read">;
  request: ResearchRequest;
  /** The contract new runs use, as for article runs (`researchExecutionFromEnv`). */
  staged: boolean;
  /** Explicit reprocessing generation; 0 is the ordinary submission. */
  reprocess?: number;
  /** Wait for the job, bounded; the invocation is never cancelled on timeout. */
  waitMs?: number;
  /** Builds a Restate UI link for an invocation, when configured. */
  inspect?: (invocationId: string) => string | undefined;
}): Promise<SubmissionOutcome> {
  const jobId = researchJobId(input.request);
  const reprocess = input.reprocess ?? 0;
  // Saved terminal work is reported, never silently repeated.
  if (reprocess === 0) {
    const saved = await input.artifacts.lookup(researchJobPath(jobId, "result"));
    if (saved) {
      const result = ResearchResultSchema.parse(JSON.parse(await input.artifacts.read(saved)));
      return { kind: "existing", jobId, result, resultRef: saved };
    }
  }
  const handler: "run" | "runStaged" = input.staged ? "runStaged" : "run";
  const sent = await input.ingress.send(
    handler,
    input.request,
    // The same call key as article research: one job, one paid run.
    researchCallKey(jobId, reprocess),
  );
  const link = input.inspect?.(sent.invocationId);
  const base = {
    kind: "submitted" as const,
    jobId,
    invocationId: sent.invocationId,
    repeated: sent.status === "PreviouslyAccepted",
    handler,
    ...(link ? { inspect: link } : {}),
  };
  if (!input.waitMs) return base;
  try {
    const job = await input.ingress.attach(sent.invocationId, AbortSignal.timeout(input.waitMs));
    return { ...base, job };
  } catch (error) {
    if (error instanceof Error && error.message === "wait-timeout") {
      return { ...base, waitEnded: "timeout" };
    }
    throw error;
  }
}
