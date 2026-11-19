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
import { TEXT_READY_SUBJECT, createTextReadyEvent } from "../events/text-ready-event.js";
import type { MediaCandidate, TranscriptionJob } from "../transcription/adapter.js";
import type { CollectionRecord, CollectionStore } from "./collection-store.js";

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

export interface CollectionWorkerConfig {
  store: CollectionStore;
  operations: OperationStore;
  collector: CollectorPort;
  /** Absent when no transcription provider is configured. */
  transcriber?: TranscriberPort;
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
        { causationId },
      );
      return [
        { eventId: event.id, subject: TEXT_READY_SUBJECT, payload: JSON.stringify(event.toJSON()) },
      ];
    };
  }

  /** Handle one delivered discovery event. Acknowledges only after durable state. */
  async handle(message: DeliveredMessage, signal?: AbortSignal): Promise<WorkerOutcome> {
    const outcome = await this.process(message, signal);
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
    try {
      const event = parseDiscoveryEvent(new TextDecoder().decode(message.data));
      const { ingestionReason, ...rest } = event.data!;
      item = rest;
      reason = ingestionReason;
      causationId = event.id;
    } catch {
      message.term();
      return { result: "invalid-event" };
    }

    const claimResult = await this.config.store.begin(item, this.config.owner, this.leaseMs, {
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
      if (committed) {
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
          item,
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
          provenance: { ...acquired.provenance },
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
          this.config.store.fail(claim, "transcription-failed", retryable);
          if (retryable) {
            message.nak(this.retryDelayMs);
            return { result: "retry", item };
          }
          await message.ack();
          return { result: "transcription-unavailable", item };
        }
        method = "machine-transcript";
        const t = job.transcript;
        record = {
          item,
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

      try {
        await this.config.store.commit(claim, record, (artifact) =>
          this.eventsFor(causationId)(artifact, record),
        );
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
    for (const pending of this.config.operations.duePendingEvents(limit)) {
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
