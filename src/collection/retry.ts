import { createHash } from "node:crypto";
import { z } from "zod";
import type { SubstackItem } from "../content/substack-item.js";
import { DEFAULT_DISCOVERY_SUBJECT } from "../controllers/nats-discovery.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { createDiscoveryEvent, serializeDiscoveryEvent } from "../events/discovery-event.js";
import { collectionKey } from "./collection-store.js";

/**
 * Deliberate, bounded retry of one terminally failed collection (#137).
 *
 * Only failures whose reason is in {@link RETRYABLE_TERMINAL_REASONS} may be
 * reopened, and only through the state controller's fenced transition, which
 * records the redelivery discovery event in the same transaction. The running
 * collector's pending-event dispatcher then publishes it, so a crash after
 * reopening cannot lose the retry. Each reopen grants exactly one attempt.
 */
export const RETRYABLE_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "transcription-unavailable",
]);

export type RetryOutcome =
  | { outcome: "reopened"; attempts: number }
  | { outcome: "already-reopened" }
  | { outcome: "not-found" }
  | { outcome: "completed" }
  | { outcome: "busy" }
  | { outcome: "not-failed"; status: string }
  | { outcome: "reason-not-retryable"; errorCode?: string }
  | { outcome: "changed" };

/** Stable event ID for one retry of one attempt count, so repeats are idempotent. */
export function retryEventId(
  item: Pick<SubstackItem, "publicationId" | "postId">,
  attempts: number,
) {
  const digest = createHash("sha256")
    .update(JSON.stringify(["collection-retry", collectionKey(item), attempts]))
    .digest("hex");
  return `retry-${digest.slice(0, 32)}`;
}

export function retryCollection(input: {
  operations: OperationStore;
  item: SubstackItem;
  subject?: string;
  now?: () => Date;
}): RetryOutcome {
  const { operations, item } = input;
  const key = collectionKey(item);
  const status = operations.operationStatus(key);
  if (!status) return { outcome: "not-found" };
  if (status.status === "completed") return { outcome: "completed" };
  if (status.status === "claimed") return { outcome: "busy" };
  if (status.status !== "failed") {
    // A released row may be one we already reopened: let the store decide.
    const eventId = retryEventId(item, status.attempts);
    return reopen(
      operations,
      item,
      key,
      eventId,
      status.attempts,
      "transcription-unavailable",
      input,
    );
  }
  if (!status.errorCode || !RETRYABLE_TERMINAL_REASONS.has(status.errorCode)) {
    return { outcome: "reason-not-retryable", errorCode: status.errorCode };
  }
  const eventId = retryEventId(item, status.attempts);
  return reopen(operations, item, key, eventId, status.attempts, status.errorCode, input);
}

function reopen(
  operations: OperationStore,
  item: SubstackItem,
  key: string,
  eventId: string,
  attempts: number,
  errorCode: string,
  input: { subject?: string; now?: () => Date },
): RetryOutcome {
  const event = createDiscoveryEvent(
    item,
    { reason: "reprocess" },
    { newId: () => eventId, now: input.now ?? (() => new Date()) },
  );
  const result = operations.reopenFailed(
    key,
    { errorCode, attempts },
    {
      eventId,
      subject: input.subject ?? DEFAULT_DISCOVERY_SUBJECT,
      payload: serializeDiscoveryEvent(event),
    },
  );
  switch (result.kind) {
    case "reopened":
      return { outcome: "reopened", attempts: result.attempts };
    case "already-reopened":
    case "not-found":
    case "completed":
    case "busy":
      return { outcome: result.kind };
    case "mismatch":
      return result.status === "failed"
        ? { outcome: "changed" }
        : { outcome: "not-failed", status: result.status };
  }
}

export const RETRY_USAGE = "Usage: retry-collection --post-id <slug> [--max-scan <n>]";

export function parseRetryArgs(argv: string[]): {
  postId: string;
  maxScan: number;
} {
  let postId: string | undefined;
  let maxScan = 2_000;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--post-id" && value) {
      postId = value;
      i++;
    } else if (argv[i] === "--max-scan" && value) {
      maxScan = z.coerce.number().int().min(1).max(10_000).parse(value);
      i++;
    } else {
      throw new Error(RETRY_USAGE);
    }
  }
  if (!postId || !/^[a-z0-9][a-z0-9-]{0,299}$/.test(postId)) throw new Error(RETRY_USAGE);
  return { postId, maxScan };
}
