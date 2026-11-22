import type { GitArtifactStore } from "../controllers/artifact-store.js";
import {
  retainEmbeddedImages,
  retainPreviewImage,
  type EmbeddedRetentionReport,
  type ImageFetcherPort,
  type PreviewRetentionOutcome,
} from "./preview-retention.js";
import { postCorrelationId } from "../observability/post-correlation.js";
import { logPipeline } from "../observability/pipeline-log.js";
import type { SubstackItem } from "../content/substack-item.js";
import type { ArtifactRef } from "../controllers/artifact-store.js";
import type { DeliveredMessage } from "../controllers/nats.js";
import type {
  OperationClaim,
  OperationStore,
  PendingEventInput,
} from "../controllers/operation-store.js";
import type { CollectionResult } from "../controllers/substack/collect.js";
import { parseDiscoveryEvent, type IngestionReason } from "../events/discovery-event.js";
import { DEFAULT_DISCOVERY_SUBJECT } from "../controllers/nats-discovery.js";
import { TEXT_READY_SUBJECT, createTextReadyEvent } from "../events/text-ready-event.js";
import {
  CAPTURED_CONTENT_SUBJECT,
  createCapturedContentEvent,
  substackCapturedContent,
} from "../events/captured-content-event.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import type { MediaCandidate, TranscriptionJob } from "../transcription/adapter.js";
import type { CollectionRecord, CollectionStore } from "./collection-store.js";
import { reingestKey } from "./collection-store.js";

/**
 * Collection worker: consumes validated discovery events (live and backfill
 * alike) and produces durable text with provenance.
 *
 * Per event:
 *   1. validate the CloudEvents envelope and payload; malformed → terminate;
 *   2. claim the post's stable collection key (#14/#22): completed → reuse
 *      and acknowledge; another live owner → retry later; exhausted → stop;
 *   3. acquire text through the Substack controller (#15), preferring the
 *      supplied transcript; otherwise transcribe audio (#16) when a provider
 *      is configured. Without a provider the supplied-transcript path still
 *      works and transcription-only posts are recorded as failed, visibly;
 *   4. commit text and provenance to the archive, then record completion and
 *      a pending text-ready event in one SQLite transaction;
 *   5. delete temporary media, acknowledge the input, and publish pending
 *      events. A failed handoff stays pending and is retried by
 *      {@link CollectionWorker.dispatchPending}; the text-ready event keeps
 *      its ID on every retry.
 *
 * The input is acknowledged only after a durable state transition. Backfill
 * keeps its ingestion reason and never makes anything publishable. No
 * indexing or article generation happens here.
 */

export interface CollectorPort {
  collect(item: SubstackItem, signal?: AbortSignal): Promise<CollectionResult>;
}

export interface TranscriberPort {
  transcribe(candidates: MediaCandidate[], signal?: AbortSignal): Promise<TranscriptionJob>;
}

export interface EventPublisherPort {
  publish(
    subject: string,
    payload: Uint8Array,
    options: { msgId: string; signal?: AbortSignal },
  ): Promise<unknown>;
}

export type WorkerOutcome =
  | "collected"
  | "already-collected"
  | "busy"
  | "exhausted"
  | "unavailable"
  | "transcription-unavailable"
  | "retry"
  | "invalid-event";

/** Subjects the collector owns in the shared outbox: text-ready handoffs and its own discovery retries. */
export const COLLECTOR_DISPATCH_SUBJECTS: readonly string[] = [
  TEXT_READY_SUBJECT,
  CAPTURED_CONTENT_SUBJECT,
  DEFAULT_DISCOVERY_SUBJECT,
];

export interface CollectionWorkerConfig {
  /**
   * Outbox subjects this worker publishes; defaults to
   * {@link COLLECTOR_DISPATCH_SUBJECTS}. Set when the discovery subject is overridden.
   */
  dispatchSubjects?: readonly string[];
  store: CollectionStore;
  operations: OperationStore;
  collector: CollectorPort;
  /** Absent when no transcription provider is configured. */
  transcriber?: TranscriberPort;
  /** Preview-image retention (#277); absent leaves records without a retained copy. */
  imageRetention?: {
    fetcher: ImageFetcherPort;
    artifacts: Pick<GitArtifactStore, "writeBinary">;
  };
  /** Sanitised retention outcome per item, for operator logs. */
  onPreviewImage?: (outcome: PreviewRetentionOutcome, item: SubstackItem) => void;
  /** Sanitised embedded-image counts per item, for operator logs. */
  onEmbeddedImages?: (report: EmbeddedRetentionReport, item: SubstackItem) => void;
  publisher: EventPublisherPort;
  /** Identity of this worker instance, used as the claim owner. */
  owner: string;
  leaseMs?: number;
  maxAttempts?: number;
  /** Delay before a retryable failure is redelivered. */
  retryDelayMs?: number;
  /**
   * Maximum interval between lease renewals and broker heartbeats. Keep it
   * below a third of the consumer's ack wait (default 60 s for the default
   * 5-minute ack wait).
   */
  heartbeatMs?: number;
  onOutcome?: (outcome: WorkerOutcome, item?: SubstackItem) => void;
}

const encoder = new TextEncoder();

/**
 * True only when the archived transcript provably belongs to the media just
 * observed: both records name the same upload identity (#558).
 */
function sameMedia(
  previous: CollectionRecord,
  acquired: { provenance: Record<string, unknown> },
): boolean {
  const before = previous.provenance.originalMediaUploadId;
  const now = acquired.provenance.originalMediaUploadId;
  return typeof before === "string" && typeof now === "string" && before === now;
}

/** Provenance fields that describe the transcript itself, not the source fetch. */
const TRANSCRIPT_FIELDS = [
  "method",
  "transcriptionProvider",
  "transcriptionModel",
  "transcriptLanguage",
  "machineGenerated",
  "mediaKind",
  "transcriptionConfidence",
  "transcriptionComplete",
  // The transcript's own upload identity and variant (supplied transcripts).
  "mediaUploadId",
  "mediaUploadKind",
  "transcriptVariant",
] as const;
function transcriptProvenance(p: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(TRANSCRIPT_FIELDS.filter((k) => k in p).map((k) => [k, p[k]]));
}

export class CollectionWorker {
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly heartbeatMs: number;

  constructor(private readonly config: CollectionWorkerConfig) {
    this.leaseMs = config.leaseMs ?? 30 * 60 * 1000;
    this.retryDelayMs = config.retryDelayMs ?? 60_000;
    this.heartbeatMs = config.heartbeatMs ?? 60_000;
  }

  /** Text-ready events derived from the record actually committed for the artifact. */
  private eventsFor(causationId: string) {
    return (artifact: ArtifactRef, record: CollectionRecord): PendingEventInput[] => {
      const event = createTextReadyEvent(
        {
          publicationId: record.item.publicationId,
          postId: record.item.postId,
          url: record.item.url,
          ingestionReason: record.ingestionReason,
          artifact: {
            repository: artifact.repository,
            commit: artifact.commit,
            path: artifact.path,
            hash: `sha256:${artifact.sha256}`,
          },
          acquisitionMethod: record.provenance.method,
          complete: record.complete,
        },
        { causationId, correlationId: postCorrelationId(record.item) },
      );
      // The source-neutral captured-content handoff (#269), committed with
      // the text-ready event; existing indexing consumers are unchanged.
      const captured = createCapturedContentEvent(
        substackCapturedContent({
          artifact: {
            repository: artifact.repository,
            commit: artifact.commit,
            path: artifact.path,
            hash: `sha256:${artifact.sha256}`,
          },
          record,
          sourceVersion: sourceVersionFor(record.text),
        }),
      );
      return [
        { eventId: event.id, subject: TEXT_READY_SUBJECT, payload: JSON.stringify(event.toJSON()) },
        {
          eventId: captured.id,
          subject: CAPTURED_CONTENT_SUBJECT,
          payload: JSON.stringify(captured.toJSON()),
        },
      ];
    };
  }

  /** Handle one delivered discovery event. Acknowledges only after durable state. */
  async handle(message: DeliveredMessage, signal?: AbortSignal): Promise<WorkerOutcome> {
    const outcome = await this.process(message, signal);
    if (outcome.item) logPipeline(outcome.item, "collection", outcome.result);
    this.config.onOutcome?.(outcome.result, outcome.item);
    return outcome.result;
  }

  private async process(
    message: DeliveredMessage,
    signal?: AbortSignal,
  ): Promise<{ result: WorkerOutcome; item?: SubstackItem }> {
    let item: SubstackItem;
    let reason: IngestionReason;
    let causationId: string;
    let reingestRequestId: string | undefined;
    try {
      const event = parseDiscoveryEvent(new TextDecoder().decode(message.data));
      const { ingestionReason, reingestRequestId: requestId, ...rest } = event.data!;
      item = rest;
      reingestRequestId = requestId;
      reason = ingestionReason;
      causationId = event.id;
    } catch {
      message.term();
      return { result: "invalid-event" };
    }

    // A deliberate reingestion (#558) runs under its own request operation;
    // ordinary discovery of an already-collected post still does nothing.
    const claimResult = reingestRequestId
      ? this.config.operations.claim(
          reingestKey(item, reingestRequestId),
          this.config.owner,
          this.leaseMs,
          this.config.maxAttempts,
        )
      : await this.config.store.begin(item, this.config.owner, this.leaseMs, {
          maxAttempts: this.config.maxAttempts,
          eventsFor: this.eventsFor(causationId),
        });
    if (claimResult.kind === "completed") {
      await message.ack();
      await this.dispatchPending(signal);
      return { result: "already-collected", item };
    }
    if (claimResult.kind === "busy") {
      message.nak(Math.max(1_000, claimResult.leaseExpiresAt - Date.now()));
      return { result: "busy", item };
    }
    if (claimResult.kind === "exhausted") {
      // A reingestion whose own version was committed before a crash on its
      // last attempt is completed from that version, never left disconnected.
      if (reingestRequestId) {
        let current: Awaited<ReturnType<CollectionStore["existing"]>>;
        try {
          current = await this.config.store.existing(item);
        } catch {
          // Unknown is not "nothing to recover": keep the delivery retryable.
          message.nak(this.retryDelayMs);
          return { result: "retry", item };
        }
        if (current?.record.reingestion?.requestId === reingestRequestId) {
          this.config.operations.reconcileCompleted(
            reingestKey(item, reingestRequestId),
            current.artifact,
            this.eventsFor(causationId)(current.artifact, current.record),
          );
          await message.ack();
          await this.dispatchPending(signal);
          return { result: "already-collected", item };
        }
      }
      await message.ack();
      return { result: "exhausted", item };
    }
    const claim = claimResult.claim;
    // Keep the claim and the broker delivery alive while acquisition runs, so a
    // slow transcription is never claimed twice; losing the lease aborts work.
    const keep = this.keepAlive(claim, message, signal);
    try {
      // An earlier attempt may have committed the artifact and crashed before
      // recording completion: finish with that durable record rather than
      // fetching the source again.
      let committed: Awaited<ReturnType<CollectionStore["existing"]>>;
      try {
        committed = await this.config.store.existing(item);
      } catch {
        // A lookup failure is not proof of absence: refetching could replace
        // the committed record. Release the claim and retry later.
        this.config.store.fail(claim, "archive-lookup-failed", true);
        message.nak(this.retryDelayMs);
        return { result: "retry", item };
      }
      // Reingestion replaces the current record and needs one to replace.
      const previous = reingestRequestId ? committed : undefined;
      if (reingestRequestId && !previous) {
        this.config.store.fail(claim, "nothing-to-reingest", false);
        await message.ack();
        return { result: "unavailable", item };
      }
      // This request already committed its version before an interruption:
      // complete the hand-off from it rather than fetching again.
      if (previous && previous.record.reingestion?.requestId === reingestRequestId) {
        try {
          this.config.operations.completeReingestion(
            claim,
            previous.artifact,
            this.eventsFor(causationId)(previous.artifact, previous.record),
          );
        } catch {
          message.nak(this.retryDelayMs);
          return { result: "retry", item };
        }
        await message.ack();
        await this.dispatchPending(signal);
        return { result: "already-collected", item };
      }
      if (committed && !reingestRequestId) {
        try {
          await this.config.store.commit(claim, committed.record, (artifact) =>
            this.eventsFor(causationId)(artifact, committed.record),
          );
        } catch {
          message.nak(this.retryDelayMs);
          return { result: "retry", item };
        }
        await message.ack();
        await this.dispatchPending(signal);
        return { result: "already-collected", item };
      }

      let acquired: CollectionResult;
      try {
        acquired = await this.config.collector.collect(item, keep.signal);
      } catch {
        acquired = { kind: "transient-failure", item, reason: "collector error" };
      }

      let record: CollectionRecord;
      let job: TranscriptionJob | undefined;
      let method = "";
      if (acquired.kind === "text") {
        method = acquired.provenance.method;
        record = {
          item: { ...item, author: acquired.item.author },
          ingestionReason: reason,
          text: acquired.text,
          complete: acquired.complete,
          supplied: {
            ...(acquired.supplied.articleHtml
              ? { articleHtml: acquired.supplied.articleHtml }
              : {}),
            ...(acquired.supplied.transcript ? { transcript: acquired.supplied.transcript } : {}),
            ...(acquired.supplied.transcriptDocument
              ? { transcriptDocument: acquired.supplied.transcriptDocument }
              : {}),
          },
          ...(acquired.previewImage ? { previewImage: acquired.previewImage } : {}),
          provenance: { ...acquired.provenance },
        };
      } else if (
        acquired.kind === "transcription-required" &&
        previous?.record.supplied.transcript?.length &&
        !sameMedia(previous.record, acquired)
      ) {
        // The archived transcript cannot be proved to belong to this media:
        // never reuse speech from another recording, and never pay to
        // retranscribe without an explicit decision.
        this.config.store.fail(claim, "transcript-media-unverified", false);
        await message.ack();
        return { result: "transcription-unavailable", item };
      } else if (
        acquired.kind === "transcription-required" &&
        previous?.record.supplied.transcript?.length
      ) {
        // Reingestion never repeats paid transcription when the current
        // record already holds a transcript of this item: reuse it, with its
        // recorded provenance.
        const t = previous.record;
        method = t.provenance.method;
        // Fresh article body from this fetch; only the transcript is reused.
        const transcriptText = t.supplied.transcript!.map((s) => s.text).join(" ");
        record = {
          item: { ...item, author: acquired.item.author },
          ingestionReason: reason,
          text: [acquired.articleText, transcriptText].filter(Boolean).join("\n\n"),
          complete: t.complete,
          supplied: { transcript: t.supplied.transcript! },
          ...(acquired.previewImage ? { previewImage: acquired.previewImage } : {}),
          // Fresh source observations from this fetch, plus only the
          // transcript-specific facts of the reused transcript.
          provenance: {
            ...acquired.provenance,
            ...transcriptProvenance(t.provenance),
            method: t.provenance.method,
          },
        };
      } else if (acquired.kind === "transcription-required") {
        if (!this.config.transcriber || acquired.media.kind !== "audio") {
          // No provider configured, or only a video upload without a fetchable URL:
          // record a visible, non-retryable outcome rather than blocking other posts.
          this.config.store.fail(claim, "transcription-unavailable", false);
          await message.ack();
          return { result: "transcription-unavailable", item };
        }
        try {
          job = await this.config.transcriber.transcribe(
            [
              {
                kind: "audio",
                url: acquired.media.url,
                durationSeconds: acquired.media.durationSeconds,
              },
            ],
            keep.signal,
          );
        } catch (error) {
          // Cancellation and a lost lease are not verdicts on the content: retry later.
          const retryable =
            (error as { retryable?: boolean }).retryable === true ||
            (error as { reason?: string }).reason === "cancelled" ||
            keep.signal.aborted;
          // No intelligible speech is a durable verdict on this source revision (#234).
          const unusable = (error as { reason?: string }).reason === "empty-transcript";
          this.config.store.fail(
            claim,
            unusable ? "transcription-unusable" : "transcription-failed",
            retryable && !unusable,
          );
          if (retryable && !unusable) {
            message.nak(this.retryDelayMs);
            return { result: "retry", item };
          }
          await message.ack();
          return { result: "transcription-unavailable", item };
        }
        method = "machine-transcript";
        const t = job.transcript;
        record = {
          item: { ...item, author: acquired.item.author },
          ingestionReason: reason,
          text: [acquired.articleText, t.text].filter(Boolean).join("\n\n"),
          complete: t.complete,
          // Keep every segment, with whatever timings the provider supplied;
          // a partly timed transcript must not lose its available timestamps.
          supplied: {
            transcript: t.segments.map((s) => ({
              ...(typeof s.start === "number" ? { start: s.start } : {}),
              ...(typeof s.end === "number" ? { end: s.end } : {}),
              text: s.text,
            })),
          },
          ...(acquired.previewImage ? { previewImage: acquired.previewImage } : {}),
          provenance: {
            ...acquired.provenance,
            method,
            transcriptionProvider: t.provider,
            transcriptionModel: t.model,
            transcriptLanguage: t.language,
            machineGenerated: true,
            mediaKind: t.mediaKind,
            // Keep the provider's own quality signal with the archived text.
            ...(t.confidence !== undefined ? { transcriptionConfidence: t.confidence } : {}),
            transcriptionComplete: t.complete,
          },
        };
      } else if (acquired.kind === "unavailable") {
        this.config.store.fail(claim, `unavailable:${acquired.reason}`, false);
        await message.ack();
        return { result: "unavailable", item };
      } else {
        this.config.store.fail(claim, "transient-failure", true);
        message.nak(this.retryDelayMs);
        return { result: "retry", item };
      }

      // Retain the eligible preview image beside the capture (#277). Saved
      // before the record, which references it only once it exists; any
      // failure just leaves the reference out.
      if (this.config.imageRetention) {
        const retained = await retainPreviewImage(record, {
          ...this.config.imageRetention,
          signal: keep.signal,
        });
        record = retained.record;
        this.config.onPreviewImage?.(retained.outcome, item);
        // Then the images embedded in or linked from the article.
        const embedded = await retainEmbeddedImages(record, {
          ...this.config.imageRetention,
          signal: keep.signal,
        });
        record = embedded.record;
        this.config.onEmbeddedImages?.(embedded.report, item);
      }

      try {
        if (previous) {
          record = { ...record, reingestion: { requestId: reingestRequestId! } };
          const final = record;
          await this.config.store.reingest(claim, final, previous.artifact.sha256, (artifact) =>
            this.eventsFor(causationId)(artifact, final),
          );
        } else {
          await this.config.store.commit(claim, record, (artifact) =>
            this.eventsFor(causationId)(artifact, record),
          );
        }
      } catch {
        // Nothing was recorded as complete; temporary media is released and the
        // input is redelivered later.
        await job?.cleanup().catch(() => undefined);
        try {
          this.config.store.fail(claim, "commit-failed", true);
        } catch {
          // Lease lost; the next owner retries.
        }
        message.nak(this.retryDelayMs);
        return { result: "retry", item };
      }
      // Durable: media can go, then acknowledge, then hand off.
      await job?.cleanup().catch(() => undefined);
      await message.ack();
      await this.dispatchPending(signal);
      return { result: "collected", item };
    } finally {
      keep.stop();
    }
  }

  /** Renew the lease and extend the ack deadline periodically until stopped. */
  private keepAlive(
    claim: OperationClaim,
    message: DeliveredMessage,
    outer?: AbortSignal,
  ): { signal: AbortSignal; stop: () => void } {
    const lost = new AbortController();
    const timer = setInterval(
      () => {
        try {
          this.config.operations.renew(claim, this.leaseMs);
          message.working();
        } catch {
          lost.abort();
        }
      },
      // Beat well inside both the claim lease and the broker ack deadline.
      Math.max(1_000, Math.min(Math.floor(this.leaseMs / 3), this.heartbeatMs)),
    );
    timer.unref?.();
    return {
      signal: outer ? AbortSignal.any([outer, lost.signal]) : lost.signal,
      stop: () => clearInterval(timer),
    };
  }

  /**
   * Publish pending text-ready events and mark each sent after broker
   * acknowledgment. A failure leaves the event pending for a later retry with
   * the same event ID. Returns the number of events sent.
   */
  async dispatchPending(signal?: AbortSignal, limit = 100): Promise<number> {
    let sent = 0;
    // Only the collector's own subjects: other stages share the configured
    // outbox (for example post-analysed events, which are published only on
    // an explicit request) and must never be sent by the collector.
    const due = (this.config.dispatchSubjects ?? COLLECTOR_DISPATCH_SUBJECTS).flatMap((subject) =>
      this.config.operations.duePendingEvents(limit, subject),
    );
    for (const pending of due) {
      if (signal?.aborted) break;
      try {
        await this.config.publisher.publish(pending.subject, encoder.encode(pending.payload), {
          msgId: pending.eventId,
          signal,
        });
        this.config.operations.markEventSent(pending.eventId);
        sent++;
      } catch {
        this.config.operations.markEventRetry(pending.eventId, this.retryDelayMs);
      }
    }
    return sent;
  }
}
