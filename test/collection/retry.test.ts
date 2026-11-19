import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { collectionKey } from "../../src/collection/collection-store.js";
import { parseRetryArgs, retryCollection, retryEventId } from "../../src/collection/retry.js";
import type { SubstackItem } from "../../src/content/substack-item.js";
import { DEFAULT_DISCOVERY_SUBJECT } from "../../src/controllers/nats-discovery.js";
import { OperationStore, OperationStoreError } from "../../src/controllers/operation-store.js";
import { parseDiscoveryEvent } from "../../src/events/discovery-event.js";

const item: SubstackItem = {
  publicationId: "pub",
  postId: "an-episode",
  url: "https://pub.example.com/p/an-episode",
  title: "An episode",
};
const key = collectionKey(item);

let dir: string;
let ops: OperationStore;
let clock: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-retry-"));
  clock = 1_000_000;
  ops = new OperationStore({
    path: join(dir, "state.sqlite"),
    now: () => clock,
  });
});
afterEach(async () => {
  ops.close();
  await rm(dir, { recursive: true, force: true });
});

/** Run one collection attempt that ends as the worker records it. */
function failAttempt(errorCode: string, retryable = false) {
  const r = ops.claim(key, "collector", 60_000, 5);
  if (r.kind !== "claimed") throw new Error(r.kind);
  ops.fail(r.claim, errorCode, retryable);
  return r.claim;
}

describe("reopening a terminal transcription-unavailable collection", () => {
  it("grants exactly one more attempt and records the redelivery event atomically", () => {
    failAttempt("transcription-unavailable");
    expect(ops.claim(key, "collector", 60_000).kind).toBe("exhausted");

    expect(retryCollection({ operations: ops, item })).toEqual({
      outcome: "reopened",
      attempts: 1,
    });
    const status = ops.operationStatus(key)!;
    expect(status.status).toBe("released");
    expect(status.errorCode).toBeUndefined();

    const [pending, ...rest] = ops.duePendingEvents();
    expect(rest).toEqual([]);
    expect(pending.eventId).toBe(retryEventId(item, 1));
    expect(pending.subject).toBe(DEFAULT_DISCOVERY_SUBJECT);
    const event = parseDiscoveryEvent(pending.payload);
    expect(event.data).toMatchObject({ ...item, ingestionReason: "reprocess" });

    // The collector's next delivery claims attempt 2; a further failure is terminal again.
    const again = ops.claim(key, "collector", 60_000);
    expect(again.kind).toBe("claimed");
    if (again.kind === "claimed") {
      expect(again.attempt).toBe(2);
      ops.fail(again.claim, "transcription-unavailable", true);
    }
    expect(ops.operationStatus(key)!.status).toBe("failed");
  });

  it("is idempotent when repeated, including after a crash before dispatch", () => {
    failAttempt("transcription-unavailable");
    expect(retryCollection({ operations: ops, item }).outcome).toBe("reopened");
    // Process restarts; the event is still pending and a repeat adds nothing.
    ops.close();
    ops = new OperationStore({
      path: join(dir, "state.sqlite"),
      now: () => clock,
    });
    expect(retryCollection({ operations: ops, item }).outcome).toBe("already-reopened");
    expect(ops.duePendingEvents()).toHaveLength(1);
    ops.markEventSent(retryEventId(item, 1));
    expect(retryCollection({ operations: ops, item }).outcome).toBe("already-reopened");
  });

  it("never touches completed, claimed or other-reason failures", () => {
    expect(retryCollection({ operations: ops, item }).outcome).toBe("not-found");

    const live = ops.claim(key, "collector", 60_000);
    expect(retryCollection({ operations: ops, item }).outcome).toBe("busy");
    if (live.kind !== "claimed") throw new Error();
    ops.complete(live.claim, { ref: "x" }, []);
    expect(retryCollection({ operations: ops, item }).outcome).toBe("completed");
    expect(ops.operationStatus(key)!.status).toBe("completed");

    const other = {
      ...item,
      postId: "paid-only",
      url: "https://pub.example.com/p/paid-only",
    };
    const k2 = collectionKey(other);
    const r = ops.claim(k2, "collector", 60_000);
    if (r.kind !== "claimed") throw new Error();
    ops.fail(r.claim, "unavailable:paid-only", false);
    expect(retryCollection({ operations: ops, item: other })).toEqual({
      outcome: "reason-not-retryable",
      errorCode: "unavailable:paid-only",
    });
    expect(ops.duePendingEvents()).toEqual([]);
  });
});

describe("OperationStore.reopenFailed fencing", () => {
  const event = { eventId: "e1", subject: "s", payload: "{}" };

  it("refuses when the observed error code or attempt count no longer matches", () => {
    failAttempt("transcription-unavailable");
    expect(
      ops.reopenFailed(key, { errorCode: "transcription-unavailable", attempts: 2 }, event).kind,
    ).toBe("mismatch");
    expect(ops.reopenFailed(key, { errorCode: "other", attempts: 1 }, event).kind).toBe("mismatch");
    expect(ops.operationStatus(key)!.status).toBe("failed");
    expect(ops.duePendingEvents()).toEqual([]);
  });

  it("loses a race with a concurrent reopen: only one event is recorded", () => {
    failAttempt("transcription-unavailable");
    const other = new OperationStore({
      path: join(dir, "state.sqlite"),
      now: () => clock,
    });
    try {
      const expected = { errorCode: "transcription-unavailable", attempts: 1 };
      expect(other.reopenFailed(key, expected, event).kind).toBe("reopened");
      expect(ops.reopenFailed(key, expected, { ...event, eventId: "e2" }).kind).toBe("mismatch");
    } finally {
      other.close();
    }
    expect(ops.duePendingEvents().map((e) => e.eventId)).toEqual(["e1"]);
  });

  it("rejects an event ID already used by another operation", () => {
    failAttempt("transcription-unavailable");
    const r = ops.claim("collect:other", "c", 60_000);
    if (r.kind !== "claimed") throw new Error();
    ops.complete(r.claim, {}, [event]);
    expect(() =>
      ops.reopenFailed(key, { errorCode: "transcription-unavailable", attempts: 1 }, event),
    ).toThrow(OperationStoreError);
  });
});

describe("parseRetryArgs", () => {
  it("accepts one post and bounded scan", () => {
    expect(parseRetryArgs(["--post-id", "a-post"])).toEqual({
      postId: "a-post",
      maxScan: 2000,
    });
    expect(parseRetryArgs(["--post-id", "a", "--max-scan", "10"]).maxScan).toBe(10);
    for (const bad of [
      [],
      ["--all"],
      ["--post-id", "../x"],
      ["--post-id", "a", "--max-scan", "0"],
    ]) {
      expect(() => parseRetryArgs(bad)).toThrow();
    }
  });
});

describe("configured discovery subject", () => {
  it("records the retry event on the subject the collector consumes", () => {
    failAttempt("transcription-unavailable");
    retryCollection({ operations: ops, item, subject: "custom.discovery" });
    expect(ops.duePendingEvents()[0].subject).toBe("custom.discovery");
  });
});
