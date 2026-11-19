import { z } from "zod";
import {
  EmbeddingError,
  EmbeddingVectorSchema,
  type EmbeddingVector,
} from "../controllers/embedding.js";
import type { OperationClaim, OperationStore } from "../controllers/operation-store.js";
import type { ArtifactReference } from "./artifact-reference.js";
import type { EmbeddingJob, EmbeddingPlan } from "./embedding-jobs.js";
import type { Passage } from "./passages.js";

/**
 * Execute one bounded batch of a passage embedding plan (#30, second slice).
 *
 * State, all through the private state controller:
 * - `embed-job:<jobKey>` marks a job done once its vector is stored, so a
 *   retry never regenerates completed work.
 * - `embed-vector:<reuseKey>` holds a validated vector for identical passage
 *   text in the same vector space, so it can be reused without a provider
 *   call (for example by another source with the same passage).
 *
 * Only jobs without a reusable vector go to the embedding controller (#28),
 * which bounds provider batch size, retries and time and validates
 * dimensions. Every vector is written through the passage-vector store (#29),
 * which refuses vectors from another vector space. Partial success is
 * reported job by job; nothing is retried in a loop here.
 */

export interface EmbeddingPort {
  embed(
    inputs: Array<{ id: string; text: string; inputHash: string }>,
    signal?: AbortSignal,
  ): Promise<EmbeddingVector[]>;
}

export interface VectorWriterPort {
  write(passage: Passage, vector: EmbeddingVector, artifact: ArtifactReference): Promise<void>;
}

export type JobFailureReason =
  | "provider-failed"
  | "invalid-output"
  | "timeout"
  | "cancelled"
  | "persistence-failed"
  | "exhausted";

export interface EmbeddingBatchResult {
  /** Jobs whose vectors were embedded now and stored. */
  embedded: string[];
  /** Jobs stored from a reusable vector without a provider call. */
  reused: string[];
  /** Jobs already completed before this batch. */
  alreadyDone: string[];
  failed: Array<{ jobKey: string; reason: JobFailureReason; retryable: boolean }>;
  /** Jobs not attempted: beyond the batch bound or claimed by another worker. */
  remaining: string[];
}

const StoredVectorSchema = z.object({ vector: EmbeddingVectorSchema }).strict();

export async function executeEmbeddingBatch(input: {
  plan: EmbeddingPlan;
  embedder: EmbeddingPort;
  vectors: VectorWriterPort;
  operations: OperationStore;
  owner: string;
  /** Upper bound on jobs attempted in this call. */
  maxJobs?: number;
  /** Jobs per provider call; failures are isolated to one sub-batch. */
  embedBatchSize?: number;
  leaseMs?: number;
  signal?: AbortSignal;
}): Promise<EmbeddingBatchResult> {
  const { plan, operations, owner } = input;
  const leaseMs = input.leaseMs ?? 10 * 60_000;
  const bound = Math.max(1, Math.min(input.maxJobs ?? 64, 1_000));
  const result: EmbeddingBatchResult = {
    embedded: [],
    reused: [],
    alreadyDone: [],
    failed: [],
    remaining: [],
  };

  type Work = {
    job: EmbeddingJob;
    jobClaim: OperationClaim;
    reuseClaim?: OperationClaim;
    vector?: EmbeddingVector;
  };
  const work: Work[] = [];
  for (const job of plan.jobs) {
    if (work.length >= bound) {
      result.remaining.push(job.jobKey);
      continue;
    }
    const jobClaim = operations.claim(`embed-job:${job.jobKey}`, owner, leaseMs);
    if (jobClaim.kind === "completed") {
      result.alreadyDone.push(job.jobKey);
      continue;
    }
    if (jobClaim.kind === "exhausted") {
      // Permanently failed or out of attempts: terminal, not pending work.
      result.failed.push({ jobKey: job.jobKey, reason: "exhausted", retryable: false });
      continue;
    }
    if (jobClaim.kind !== "claimed") {
      result.remaining.push(job.jobKey);
      continue;
    }
    const reuse = operations.claim(`embed-vector:${job.reuseKey}`, owner, leaseMs);
    if (reuse.kind === "completed") {
      const stored = StoredVectorSchema.safeParse(reuse.artifact);
      // A stored vector from another space, or of the wrong shape, is never reused.
      if (stored.success && stored.data.vector.vectorSpace === plan.vectorSpace) {
        work.push({
          job,
          jobClaim: jobClaim.claim,
          vector: { ...stored.data.vector, inputId: job.passage.id },
        });
        continue;
      }
    }
    work.push({
      job,
      jobClaim: jobClaim.claim,
      ...(reuse.kind === "claimed" ? { reuseClaim: reuse.claim } : {}),
    });
  }

  // Renew every lease still held; a job whose lease was lost goes back to
  // the queue untouched so another invocation can finish it.
  const lost = new Set<Work>();
  // Jobs already failed in an earlier sub-batch: their leases are released
  // and they are reported once, never renewed or listed as remaining.
  const settled = new Set<Work>();
  const renewAll = () => {
    for (const w of work) {
      if (lost.has(w) || settled.has(w)) continue;
      try {
        operations.renew(w.jobClaim, leaseMs);
        if (w.reuseClaim) operations.renew(w.reuseClaim, leaseMs);
      } catch {
        lost.add(w);
      }
    }
  };

  // Embed only what has no reusable vector, one provider-sized sub-batch at a
  // time, so a failure affects only the sub-batch that actually failed.
  const toEmbed = work.filter((w) => !w.vector);
  const subBatch = Math.max(1, Math.min(input.embedBatchSize ?? 32, 512));
  for (let at = 0; at < toEmbed.length; at += subBatch) {
    renewAll();
    const slice = toEmbed.slice(at, at + subBatch).filter((w) => !lost.has(w));
    if (slice.length === 0) continue;
    let produced: EmbeddingVector[] = [];
    let failure: EmbeddingError | undefined;
    try {
      produced = await input.embedder.embed(
        slice.map((w) => ({
          id: w.job.passage.id,
          text: w.job.passage.text,
          inputHash: w.job.inputHash,
        })),
        input.signal,
      );
    } catch (error) {
      failure =
        error instanceof EmbeddingError ? error : new EmbeddingError("provider-failed", true);
      produced = failure.completed;
    }
    const byId = new Map(produced.map((v) => [v.inputId, v]));
    for (const w of slice) {
      const vector = byId.get(w.job.passage.id);
      if (vector) {
        w.vector = vector;
        continue;
      }
      const reason = (failure?.reason ?? "provider-failed") as JobFailureReason;
      // Cancellation says nothing about the job: keep it recoverable.
      const retryable = reason === "cancelled" ? true : (failure?.retryable ?? true);
      operations.fail(w.jobClaim, `embed:${reason}`, retryable);
      if (w.reuseClaim) operations.fail(w.reuseClaim, `embed:${reason}`, retryable);
      settled.add(w);
      result.failed.push({ jobKey: w.job.jobKey, reason, retryable });
    }
    if (input.signal?.aborted) break;
  }

  // Store each vector, then record completion.
  for (const w of work) {
    if (!w.vector) {
      if (settled.has(w)) continue; // already reported as failed
      // Never attempted (cancelled before its sub-batch) or lease lost: still pending.
      if (!lost.has(w)) operations.fail(w.jobClaim, "embed:not-attempted", true);
      result.remaining.push(w.job.jobKey);
      continue;
    }
    renewAll();
    if (lost.has(w)) {
      result.remaining.push(w.job.jobKey);
      continue;
    }
    const reusedNow = w.reuseClaim === undefined && !toEmbed.includes(w);
    if (w.reuseClaim) {
      operations.complete(w.reuseClaim, { vector: w.vector }, []);
    }
    try {
      await input.vectors.write(w.job.passage, w.vector, plan.artifact);
    } catch {
      operations.fail(w.jobClaim, "embed:persistence-failed", true);
      result.failed.push({ jobKey: w.job.jobKey, reason: "persistence-failed", retryable: true });
      continue;
    }
    operations.complete(w.jobClaim, { passageId: w.job.passage.id, reuseKey: w.job.reuseKey }, []);
    (reusedNow ? result.reused : result.embedded).push(w.job.jobKey);
  }
  return result;
}
