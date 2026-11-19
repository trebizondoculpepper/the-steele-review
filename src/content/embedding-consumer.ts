import { randomUUID } from "node:crypto";
import { CloudEvent } from "cloudevents";
import { CollectionRecordSchema } from "../collection/collection-store.js";
import { toArchiveRef } from "../collection/fulltext-projection.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { EmbeddingModel } from "../controllers/embedding.js";
import type { DeliveredMessage } from "../controllers/nats.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { parseTextReadyEvent } from "../events/text-ready-event.js";
import {
  executeEmbeddingBatch,
  type EmbeddingPort,
  type VectorWriterPort,
} from "./embedding-batch.js";
import { planEmbeddingJobs } from "./embedding-jobs.js";
import { sourceVersionFor } from "./fulltext-document.js";
import { DEFAULT_CHUNKING, chunkingKey, type ChunkingConfig } from "./passage-vectors.js";

/**
 * Embedding consumer (#30, final slice): text-ready event → planned passage
 * jobs (#96) → bounded batches (#97) → completion and `content.embedded`
 * handoff.
 *
 * - One operation per post, source version, vector space and chunking, so a
 *   repeat event reuses the result and a changed model or chunking is new,
 *   deliberate work.
 * - Each delivery runs at most `maxBatches` batches of `maxJobs` jobs.
 *   Progress is recorded per job by the batch executor, so redelivery,
 *   partial failures and shutdown never lose or repeat completed jobs.
 * - The operation completes, with its handoff event, only when every
 *   planned job has a stored vector; otherwise the message is redelivered.
 *   Permanent job failures stop the operation visibly.
 * - Provider retries live in the embedding controller; none are added here.
 */

export const CONTENT_EMBEDDED_SUBJECT = "steele.v1.content.embedded";
export const CONTENT_EMBEDDED_EVENT_TYPE_V1 = "org.steele.content.embedded.v1";

export type EmbeddingConsumerOutcome =
  | "embedded"
  | "already-embedded"
  | "in-progress"
  | "busy"
  | "failed"
  | "incomplete-source"
  | "retry"
  | "invalid-event";

export interface EmbeddingConsumerConfig {
  artifacts: Pick<GitArtifactStore, "read">;
  embedder: EmbeddingPort;
  vectors: VectorWriterPort;
  model: EmbeddingModel;
  chunking?: ChunkingConfig;
  operations: OperationStore;
  publisher: {
    publish(subject: string, payload: Uint8Array, options: { msgId: string }): Promise<unknown>;
  };
  owner: string;
  maxJobs?: number;
  maxBatches?: number;
  retryDelayMs?: number;
}

export class EmbeddingConsumer {
  constructor(private readonly config: EmbeddingConsumerConfig) {}

  async handle(message: DeliveredMessage, signal?: AbortSignal): Promise<EmbeddingConsumerOutcome> {
    const { operations } = this.config;
    const retryDelay = this.config.retryDelayMs ?? 60_000;
    let event;
    try {
      event = parseTextReadyEvent(new TextDecoder().decode(message.data));
    } catch {
      message.term();
      return "invalid-event";
    }
    const data = event.data!;

    let record;
    try {
      record = CollectionRecordSchema.parse(
        JSON.parse(await this.config.artifacts.read(toArchiveRef(data.artifact))),
      );
    } catch {
      message.nak(retryDelay);
      return "retry";
    }
    const sourceId = `substack/${data.publicationId}/${data.postId}`;
    const sourceVersion = sourceVersionFor(record.text);
    const chunking = this.config.chunking ?? DEFAULT_CHUNKING;
    const plan = planEmbeddingJobs({
      sourceId,
      text: record.text,
      sourceVersion,
      artifact: data.artifact,
      model: this.config.model,
      chunking,
      ...(record.item.publishedAt ? { publishedAt: record.item.publishedAt } : {}),
    });
    const key = `embed-source:${sourceId}:${sourceVersion}:${plan.vectorSpace}:${chunkingKey(chunking)}`;
    if (!record.complete) {
      operations.recordPermanentFailure(key, "incomplete-source");
      await message.ack();
      return "incomplete-source";
    }

    const claimed = operations.claim(key, this.config.owner, 30 * 60_000, 50);
    if (claimed.kind === "completed") {
      await message.ack();
      await this.dispatchPending();
      return "already-embedded";
    }
    if (claimed.kind === "busy") {
      message.nak(Math.max(1_000, claimed.leaseExpiresAt - Date.now()));
      return "busy";
    }
    if (claimed.kind === "exhausted") {
      await message.ack();
      return "failed";
    }
    const claim = claimed.claim;

    let done = 0;
    let permanentFailure: string | undefined;
    const maxBatches = Math.max(1, Math.min(this.config.maxBatches ?? 4, 100));
    for (let batch = 0; batch < maxBatches; batch++) {
      if (signal?.aborted) break;
      const result = await executeEmbeddingBatch({
        plan,
        embedder: this.config.embedder,
        vectors: this.config.vectors,
        operations,
        owner: this.config.owner,
        maxJobs: this.config.maxJobs ?? 64,
        signal,
      });
      done = result.alreadyDone.length + result.embedded.length + result.reused.length;
      const permanent = result.failed.find((f) => !f.retryable);
      if (permanent) {
        permanentFailure = permanent.reason;
        break;
      }
      if (done >= plan.jobs.length || result.failed.length > 0 || result.remaining.length === 0)
        break;
    }

    if (permanentFailure) {
      operations.fail(claim, `embed:${permanentFailure}`, false);
      await message.ack();
      return "failed";
    }
    if (done < plan.jobs.length) {
      // Progress is recorded per job; release the source claim and come back.
      operations.fail(claim, signal?.aborted ? "embed:shutdown" : "embed:in-progress", true);
      message.nak(signal?.aborted ? 0 : Math.min(retryDelay, 5_000));
      return signal?.aborted ? "retry" : "in-progress";
    }

    const handoff = new CloudEvent({
      specversion: "1.0",
      id: randomUUID(),
      source: "urn:steele:embedding:worker",
      type: CONTENT_EMBEDDED_EVENT_TYPE_V1,
      time: new Date().toISOString(),
      subject: sourceId,
      datacontenttype: "application/json",
      causationid: event.id,
      data: {
        publicationId: data.publicationId,
        postId: data.postId,
        sourceVersion,
        vectorSpace: plan.vectorSpace,
        chunking: chunkingKey(chunking),
        indexName: plan.indexName,
        passages: plan.jobs.length,
        ingestionReason: data.ingestionReason,
      },
    });
    operations.complete(claim, { indexName: plan.indexName, passages: plan.jobs.length }, [
      {
        eventId: handoff.id,
        subject: CONTENT_EMBEDDED_SUBJECT,
        payload: JSON.stringify(handoff.toJSON()),
      },
    ]);
    await message.ack();
    await this.dispatchPending();
    return "embedded";
  }

  async dispatchPending(limit = 100): Promise<number> {
    let sent = 0;
    for (const p of this.config.operations.duePendingEvents(limit, CONTENT_EMBEDDED_SUBJECT)) {
      try {
        await this.config.publisher.publish(p.subject, new TextEncoder().encode(p.payload), {
          msgId: p.eventId,
        });
        this.config.operations.markEventSent(p.eventId);
        sent++;
      } catch {
        this.config.operations.markEventRetry(p.eventId, this.config.retryDelayMs ?? 60_000);
      }
    }
    return sent;
  }
}
