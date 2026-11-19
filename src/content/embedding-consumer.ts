import { createHash, randomUUID } from "node:crypto";
import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { CollectionRecordSchema, type CollectionRecord } from "../collection/collection-store.js";
import { toArchiveRef } from "../collection/fulltext-projection.js";
import { ArtifactStoreError, type GitArtifactStore } from "../controllers/artifact-store.js";
import { vectorSpaceId, type EmbeddingModel } from "../controllers/embedding.js";
import type { DeliveredMessage } from "../controllers/nats.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { parseTextReadyEvent } from "../events/text-ready-event.js";
import {
  executeEmbeddingBatch,
  type EmbeddingPort,
  type VectorWriterPort,
} from "./embedding-batch.js";
import { EmbeddingPlanError, planEmbeddingJobs } from "./embedding-jobs.js";
import { sourceVersionFor } from "./fulltext-document.js";
import type { TranscriptTiming } from "./passages.js";
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
export const CONTENT_EMBEDDED_DATASCHEMA_V1 = "urn:steele:schema:content-embedded:v1";
export const EMBEDDING_WORKER_SOURCE = "urn:steele:embedding:worker";

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

/** Versioned payload of the `content.embedded` handoff. */
export const ContentEmbeddedDataSchema = z
  .object({
    publicationId: Id,
    postId: Id,
    sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    // Percent-encoded model identities can be long; bounded generously.
    vectorSpace: z.string().min(1).max(4000),
    chunking: z.string().min(1).max(1000),
    indexName: z.string().min(1).max(255),
    passages: z.number().int().min(1),
    ingestionReason: z.enum(["live", "backfill", "reprocess"]),
  })
  .strict();
export type ContentEmbeddedData = z.infer<typeof ContentEmbeddedDataSchema>;

const ContentEmbeddedEnvelopeSchema = z
  .object({
    specversion: z.literal("1.0"),
    id: z.string().min(1).max(200),
    source: z.string().min(1).max(500),
    type: z.literal(CONTENT_EMBEDDED_EVENT_TYPE_V1),
    time: z.iso.datetime({ offset: true }),
    subject: z.string().min(1).max(500),
    datacontenttype: z.literal("application/json"),
    dataschema: z.literal(CONTENT_EMBEDDED_DATASCHEMA_V1),
    causationid: z.string().min(1).max(200).optional(),
    data: ContentEmbeddedDataSchema,
  })
  .strict()
  .refine((e) => e.subject === `substack/${e.data.publicationId}/${e.data.postId}`, {
    message: "subject does not match the post",
  });

/** Parse and validate a serialised `content.embedded` event. */
export function parseContentEmbeddedEvent(
  input: string,
): z.infer<typeof ContentEmbeddedEnvelopeSchema> {
  return ContentEmbeddedEnvelopeSchema.parse(JSON.parse(input));
}

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
    } catch (error) {
      // Only a transient Git failure is worth redelivery; a missing, tampered
      // or malformed record will never become valid, so record it and stop.
      if (error instanceof ArtifactStoreError && error.code === "git-failed") {
        message.nak(retryDelay);
        return "retry";
      }
      operations.recordPermanentFailure(`embed-invalid:${event.id}`, "unreadable-source");
      await message.ack();
      return "failed";
    }
    const sourceId = `substack/${data.publicationId}/${data.postId}`;
    const sourceVersion = sourceVersionFor(record.text);
    const chunking = this.config.chunking ?? DEFAULT_CHUNKING;
    // Hashed so long post or model identifiers always fit the store's key bound.
    const key = `embed-source:${createHash("sha256")
      .update(
        `${sourceId}\n${sourceVersion}\n${vectorSpaceId(this.config.model)}\n${chunkingKey(chunking)}`,
      )
      .digest("hex")}`;
    // The archived record must belong to the post the event names, or its
    // passages would carry another post's provenance.
    if (record.item.publicationId !== data.publicationId || record.item.postId !== data.postId) {
      operations.recordPermanentFailure(`embed-invalid:${event.id}`, "identity-mismatch");
      await message.ack();
      return "failed";
    }
    let plan;
    try {
      plan = planEmbeddingJobs({
        sourceId,
        text: record.text,
        sourceVersion,
        artifact: data.artifact,
        model: this.config.model,
        chunking,
        ...(record.item.publishedAt ? { publishedAt: record.item.publishedAt } : {}),
        ...transcriptTimingsFor(record, chunking.maxChars),
      });
    } catch (error) {
      if (error instanceof EmbeddingPlanError) {
        operations.recordPermanentFailure(key, `plan:${error.reason}`);
        await message.ack();
        return "failed";
      }
      throw error;
    }
    if (!record.complete) {
      // Event-scoped: a later complete record with the same text must still run.
      operations.recordPermanentFailure(`embed-invalid:${event.id}`, "incomplete-source");
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
      // Progress is not failure: hand the claim back without spending an attempt.
      operations.yieldClaim(claim);
      message.nak(signal?.aborted ? 0 : Math.min(retryDelay, 5_000));
      return signal?.aborted ? "retry" : "in-progress";
    }

    const handoff = new CloudEvent({
      specversion: "1.0",
      id: randomUUID(),
      source: EMBEDDING_WORKER_SOURCE,
      type: CONTENT_EMBEDDED_EVENT_TYPE_V1,
      time: new Date().toISOString(),
      subject: sourceId,
      datacontenttype: "application/json",
      dataschema: CONTENT_EMBEDDED_DATASCHEMA_V1,
      causationid: event.id,
      data: ContentEmbeddedDataSchema.parse({
        publicationId: data.publicationId,
        postId: data.postId,
        sourceVersion,
        vectorSpace: plan.vectorSpace,
        chunking: chunkingKey(chunking),
        indexName: plan.indexName,
        passages: plan.jobs.length,
        ingestionReason: data.ingestionReason,
      }),
    });
    // The emitted envelope must satisfy the published contract.
    const payload = JSON.stringify(handoff.toJSON());
    parseContentEmbeddedEvent(payload);
    operations.complete(claim, { indexName: plan.indexName, passages: plan.jobs.length }, [
      {
        eventId: handoff.id,
        subject: CONTENT_EMBEDDED_SUBJECT,
        payload,
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

/**
 * Align supplied timed transcript segments to offsets in the record text,
 * in order. Segments without both times, or not found verbatim, are left
 * out: no timing is ever guessed.
 */
/** Bound on timings stored with one passage vector. */
export const MAX_PASSAGE_TIMINGS = 500;

export function transcriptTimingsFor(
  record: CollectionRecord,
  /** Largest passage size; timings are coalesced so no passage overlaps more than the stored bound. */
  maxPassageChars = DEFAULT_CHUNKING.maxChars,
): {
  transcriptTimings?: TranscriptTiming[];
} {
  const segments = record.supplied.transcript;
  if (!segments?.length) return {};
  // The collector stores article text, then the transcript: alignment is
  // restricted to that trailing transcript span so article words never match.
  // Same join as the collector's transcriptText.
  const transcript = segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
  if (!transcript || !record.text.endsWith(transcript)) return {};
  const base = record.text.length - transcript.length;
  // Each timing records its contiguous run: an untimed or unaligned segment
  // ends the run, so merging never bridges text with no supplied timing.
  const timings: Array<TranscriptTiming & { run: number }> = [];
  let run = 0;
  let cursor = 0;
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    const at = transcript.indexOf(text, cursor);
    if (at === -1) {
      run++;
      continue;
    }
    cursor = at + text.length;
    // Zero-length or untimed segments are skipped: no timing is guessed.
    if (s.start === undefined || s.end === undefined || s.end <= s.start) {
      run++;
      continue;
    }
    timings.push({
      run,
      start: base + at,
      end: base + cursor,
      startSeconds: s.start,
      endSeconds: s.end,
    });
  }
  if (!timings.length) return {};
  // A passage stores at most MAX_PASSAGE_TIMINGS timings. Merge consecutive
  // segments until each spans enough text that no passage can overlap more;
  // a merged timing runs from its first start to its last end, so it is
  // coarser but never wrong.
  const minChars = Math.ceil(maxPassageChars / (MAX_PASSAGE_TIMINGS - 2));
  const merged: Array<TranscriptTiming & { run: number }> = [];
  for (const t of timings) {
    const prev = merged.at(-1);
    if (prev && prev.run === t.run && prev.end - prev.start < minChars) {
      merged[merged.length - 1] = {
        ...prev,
        end: t.end,
        endSeconds: Math.max(prev.endSeconds, t.endSeconds),
      };
    } else merged.push({ ...t });
  }
  const plain = merged.map(({ run: _run, ...t }) => t);
  // Short runs are kept when no passage-sized window could overlap more
  // timings than the stored bound; only when one could are runs too short to
  // reach the minimum span left out (rather than stretched over untimed text).
  const kept = withinBound(plain, maxPassageChars)
    ? plain
    : plain.filter((t) => t.end - t.start >= minChars);
  return kept.length ? { transcriptTimings: kept } : {};
}

/**
 * True when no window of `width` characters overlaps more than
 * MAX_PASSAGE_TIMINGS of the ordered, non-overlapping timings. The count is
 * conservative: one timing straddling the window start is always added.
 */
function withinBound(timings: TranscriptTiming[], width: number): boolean {
  let j = 0;
  for (let i = 0; i < timings.length; i++) {
    if (j < i) j = i;
    while (j < timings.length && timings[j]!.start < timings[i]!.start + width) j++;
    if (j - i + 1 > MAX_PASSAGE_TIMINGS) return false;
  }
  return true;
}
