import { randomUUID } from "node:crypto";
import type { SubstackItem } from "../content/substack-item.js";
import type {
  DiscoveryEvent,
  DiscoveryEventOptions,
  IngestionReason,
} from "../events/discovery-event.js";

/**
 * One discovery run: iterate normalised items from any source, build one
 * discovery event per item and await its durable publication, sequentially.
 * No timer, no network client and no retry loop here: retries belong to the
 * publisher, which must reuse the same event (and so the same event ID) for
 * every attempt. A run stops at the first unrecoverable source, event or
 * publish error and reports a partial result; already published events stay
 * published, so rerunning is safe given downstream content deduplication.
 */

/** Durable handoff of one event; resolves only after acknowledgment. */
export interface DiscoveryPublisher {
  publish(event: DiscoveryEvent, signal?: AbortSignal): Promise<void>;
}

export type DiscoveryEventFactory = (
  item: SubstackItem,
  options: DiscoveryEventOptions,
) => DiscoveryEvent;

export interface DiscoveryRunInput {
  source: AsyncIterable<SubstackItem>;
  reason: IngestionReason;
  createEvent: DiscoveryEventFactory;
  publisher: DiscoveryPublisher;
  /** Correlation ID shared by every event of this run; generated if omitted. */
  correlationId?: string;
  signal?: AbortSignal;
}

export type DiscoveryRunStatus = "complete" | "failed" | "cancelled";
export type DiscoveryFailureStage = "source" | "event" | "publish";

export interface DiscoveryRunSummary {
  status: DiscoveryRunStatus;
  correlationId: string;
  reason: IngestionReason;
  /** Items received from the source. */
  discovered: number;
  /** Events whose publication was acknowledged. */
  published: number;
  /** Present when status is "failed": where it failed and the error class name only. */
  failure?: { stage: DiscoveryFailureStage; errorName: string };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/** Run one discovery pass. Never throws for source/publish failures; inspect `status`. */
export async function runDiscovery(input: DiscoveryRunInput): Promise<DiscoveryRunSummary> {
  const { signal } = input;
  const summary: DiscoveryRunSummary = {
    status: "complete",
    correlationId: input.correlationId ?? randomUUID(),
    reason: input.reason,
    discovered: 0,
    published: 0,
  };
  const stop = (stage: DiscoveryFailureStage, error: unknown): DiscoveryRunSummary => {
    if (signal?.aborted) return { ...summary, status: "cancelled" };
    return { ...summary, status: "failed", failure: { stage, errorName: errorName(error) } };
  };

  if (signal?.aborted) return { ...summary, status: "cancelled" };
  const iterator = input.source[Symbol.asyncIterator]();
  try {
    for (;;) {
      let next: IteratorResult<SubstackItem>;
      try {
        next = await iterator.next();
      } catch (error) {
        return stop("source", error);
      }
      if (next.done) break;
      summary.discovered++;
      if (signal?.aborted) return { ...summary, status: "cancelled" };

      let event: DiscoveryEvent;
      try {
        event = input.createEvent(next.value, {
          reason: input.reason,
          correlationId: summary.correlationId,
        });
      } catch (error) {
        return stop("event", error);
      }
      try {
        await input.publisher.publish(event, signal);
      } catch (error) {
        return stop("publish", error);
      }
      summary.published++;
    }
  } finally {
    // Release the source (e.g. close an HTTP stream) if we stopped early.
    await iterator.return?.().catch(() => undefined);
  }
  return signal?.aborted ? { ...summary, status: "cancelled" } : summary;
}
