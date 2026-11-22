import * as clients from "@restatedev/restate-sdk-clients";
import { z } from "zod";
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
      return { invocationId: send.invocationId, status: send.status };
    },
    async attach(invocationId, signal) {
      // Attach over plain HTTP so the client-side request is aborted when the
      // wait ends; the durable invocation itself is never cancelled.
      let res: Response;
      try {
        res = await fetch(
          `${ingressUrl.replace(/\/+$/, "")}/restate/invocation/${encodeURIComponent(invocationId)}/attach`,
          { headers: { accept: "application/json" }, signal },
        );
      } catch (error) {
        if (signal.aborted) throw new Error("wait-timeout");
        throw error;
      }
      if (!res.ok) throw new Error(`attach failed (HTTP ${res.status})`);
      // An external boundary: the job envelope, result and refs are validated.
      const parsed = CommissionedJobSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new Error("attach returned an invalid job");
      return parsed.data as CommissionedJob;
    },
  };
}

const RefSchema = z
  .object({
    repository: z.string().min(1).max(500),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    path: z.string().min(1).max(1000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const CommissionedJobSchema = z
  .object({
    jobId: z.string().regex(/^research-[0-9a-f]{32}$/),
    status: z.enum(["finished", "busy", "not-commissioned"]),
    result: ResearchResultSchema.optional(),
    resultRef: RefSchema.optional(),
  })
  .strict();

export type SubmissionOutcome = {
  kind: "submitted";
  jobId: string;
  invocationId: string;
  /** True when Restate already had this exact submission. */
  repeated: boolean;
  handler: "run" | "runStaged";
  job?: CommissionedJob;
  /** Set when `wait` ended before the job finished; the invocation keeps running. */
  waitEnded?: "timeout";
};

/** The request a reprocessing generation submits: a later pass linked to the original job. */
export function reprocessedRequest(request: ResearchRequest, reprocess = 0): ResearchRequest {
  return reprocess > 0
    ? { ...request, pass: request.pass + reprocess, previousJobId: researchJobId(request) }
    : request;
}

export async function submitManualResearch(input: {
  ingress: ResearchIngressPort;
  request: ResearchRequest;
  /** The contract new runs use, as for article runs (`researchExecutionFromEnv`). */
  staged: boolean;
  /** Explicit reprocessing generation; 0 is the ordinary submission. */
  reprocess?: number;
  /** Wait for the job, bounded; the invocation is never cancelled on timeout. */
  waitMs?: number;
}): Promise<SubmissionOutcome> {
  // Reprocessing is a new durable job, not a new call to the old one, so
  // earlier artifacts stay untouched and the worker cannot reuse the old result.
  const request = reprocessedRequest(input.request, input.reprocess);
  const jobId = researchJobId(request);
  // Always submitted: the worker reuses a saved result without new discovery
  // and, through the state controller, repairs a missing completion event.
  // The stable call key makes a repeat attach to the same invocation.
  const handler: "run" | "runStaged" = input.staged ? "runStaged" : "run";
  const sent = await input.ingress.send(handler, request, researchCallKey(jobId));
  const base = {
    kind: "submitted" as const,
    jobId,
    invocationId: sent.invocationId,
    repeated: sent.status === "PreviouslyAccepted",
    handler,
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
