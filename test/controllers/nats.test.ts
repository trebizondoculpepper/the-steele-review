import { describe, expect, it } from "vite-plus/test";
import {
  NatsController,
  NatsPublishError,
  assertPublishSubject,
  publishWithRetry,
  type JetStreamPublisherLike,
} from "../../src/controllers/nats.js";
import {
  NatsDiscoveryPublisher,
  discoveryMessageId,
} from "../../src/controllers/nats-discovery.js";
import {
  StreamConflictError,
  provisionDiscoveryStream,
} from "../../src/controllers/nats-provision.js";
import { createDiscoveryEvent, parseDiscoveryEvent } from "../../src/events/discovery-event.js";
import type { SubstackItem } from "../../src/content/substack-item.js";

const item: SubstackItem = {
  publicationId: "example-pub",
  postId: "a-synthetic-post",
  url: "https://example-pub.substack.com/p/a-synthetic-post",
  title: "A synthetic post",
};
const payload = new TextEncoder().encode("{}");
const noSleep = async () => {};

function fakeJs(results: Array<Error | { stream: string; seq: number; duplicate: boolean }>) {
  const calls: Array<{ subject: string; msgID?: string }> = [];
  const js: JetStreamPublisherLike = {
    async publish(subject, _payload, options) {
      calls.push({ subject, msgID: options.msgID });
      const next = results.shift();
      if (!next) throw new Error("unexpected call");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { js, calls };
}

const named = (name: string, message = "detail with nats://private.example:4222") => {
  const error = new Error(message);
  error.name = name;
  return error;
};

describe("assertPublishSubject", () => {
  it("accepts literal subjects and rejects wildcards or empty tokens", () => {
    expect(assertPublishSubject("steele.v1.source.detected")).toBe("steele.v1.source.detected");
    for (const bad of ["steele.*", "steele.>", "steele..x", "", "a b"]) {
      expect(() => assertPublishSubject(bad)).toThrow();
    }
  });
});

describe("publishWithRetry", () => {
  it("returns the acknowledgment receipt", async () => {
    const { js, calls } = fakeJs([{ stream: "S", seq: 7, duplicate: false }]);
    const receipt = await publishWithRetry(js, "a.b", payload, { msgId: "m1" });
    expect(receipt).toEqual({ stream: "S", seq: 7, duplicate: false, attempts: 1 });
    expect(calls).toEqual([{ subject: "a.b", msgID: "m1" }]);
  });

  it("retries a failed acknowledgment with the same message ID", async () => {
    const { js, calls } = fakeJs([
      named("TimeoutError"),
      named("NoRespondersError"),
      { stream: "S", seq: 8, duplicate: true },
    ]);
    const receipt = await publishWithRetry(js, "a.b", payload, {
      msgId: "m1",
      maxAttempts: 3,
      sleep: noSleep,
    });
    expect(receipt).toMatchObject({ seq: 8, duplicate: true, attempts: 3 });
    expect(calls.map((c) => c.msgID)).toEqual(["m1", "m1", "m1"]);
  });

  it("gives up after bounded attempts with a sanitised error", async () => {
    const { js } = fakeJs([named("TimeoutError"), named("TimeoutError")]);
    const error = await publishWithRetry(js, "a.b", payload, {
      msgId: "m1",
      maxAttempts: 2,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NatsPublishError);
    expect((error as NatsPublishError).code).toBe("timeout");
    expect(String(error)).not.toContain("private");
  });

  it("does not retry a server rejection", async () => {
    const { js, calls } = fakeJs([named("JetStreamApiError", "expected stream does not match")]);
    await expect(
      publishWithRetry(js, "a.b", payload, { msgId: "m1", sleep: noSleep }),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(calls).toHaveLength(1);
  });

  it("stops on cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const { js, calls } = fakeJs([]);
    await expect(
      publishWithRetry(js, "a.b", payload, { msgId: "m1", signal: abort.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toHaveLength(0);
  });
});

describe("NatsDiscoveryPublisher", () => {
  it("validates, serialises and keys the message by event identity", async () => {
    const sent: Array<{ subject: string; body: string; msgId: string }> = [];
    const publisher = new NatsDiscoveryPublisher({
      async publish(subject, bytes, options) {
        sent.push({ subject, body: new TextDecoder().decode(bytes), msgId: options.msgId });
        return { stream: "S", seq: 1, duplicate: false, attempts: 1 };
      },
    });
    const event = createDiscoveryEvent(item, { reason: "live" });
    await publisher.publish(event);
    await publisher.publish(event);
    expect(sent[0]!.subject).toBe("steele.v1.source.detected");
    expect(parseDiscoveryEvent(sent[0]!.body).id).toBe(event.id);
    expect(sent[0]!.msgId).toBe(discoveryMessageId(event));
    expect(sent[1]!.msgId).toBe(sent[0]!.msgId);
  });

  it("derives distinct message IDs for identities that share a delimiter", () => {
    const a = discoveryMessageId({ source: "https://example.test/a#b", id: "c" });
    const b = discoveryMessageId({ source: "https://example.test/a", id: "b#c" });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an invalid event before sending", async () => {
    let called = false;
    const publisher = new NatsDiscoveryPublisher({
      async publish() {
        called = true;
        return { stream: "S", seq: 1, duplicate: false, attempts: 1 };
      },
    });
    const event = createDiscoveryEvent(item, { reason: "live" });
    const tampered = event.cloneWith({ subject: "substack/other/post" }, false);
    await expect(publisher.publish(tampered)).rejects.toThrow("Invalid discovery event");
    expect(called).toBe(false);
  });

  it("rejects a wildcard subject", () => {
    expect(
      () =>
        new NatsDiscoveryPublisher(
          { publish: async () => ({ stream: "", seq: 0, duplicate: false, attempts: 0 }) },
          { subject: "steele.>" },
        ),
    ).toThrow();
  });
});

// Controlled integration tests against a disposable JetStream server.
// Start one with scripts/nats-test-server.sh and set STEELE_TEST_NATS_URL.
const testUrl = process.env.STEELE_TEST_NATS_URL;
describe.skipIf(!testUrl)("JetStream integration", () => {
  const run = Date.now().toString(36);
  const stream = `STEELE_TEST_${run}`;
  const subject = `steele.test.${run}.source.detected`;

  it("round-trips an acknowledged event, deduplicates a retry and rejects invalid targets", async () => {
    const nats = new NatsController(testUrl!);
    await nats.connect("steele-test");
    try {
      expect(await provisionDiscoveryStream(nats, { name: stream, subjects: [subject] })).toBe(
        "created",
      );
      expect(await provisionDiscoveryStream(nats, { name: stream, subjects: [subject] })).toBe(
        "unchanged",
      );
      await expect(
        provisionDiscoveryStream(nats, { name: stream, subjects: [`${subject}.other`] }),
      ).rejects.toBeInstanceOf(StreamConflictError);

      // Concurrent connect calls share one connection.
      await Promise.all([nats.connect("steele-test"), nats.connect("steele-test")]);

      const publisher = new NatsDiscoveryPublisher(nats, { subject, expectStream: stream });
      const event = createDiscoveryEvent(item, { reason: "backfill", correlationId: "run-1" });
      await publisher.publish(event);
      const first = publisher.lastReceipt!;
      expect(first).toMatchObject({ stream, duplicate: false });

      // Retrying the same event is acknowledged as a duplicate of the stored message.
      await publisher.publish(event);
      expect(publisher.lastReceipt).toMatchObject({ seq: first.seq, duplicate: true });

      const jsm = await nats.manager();
      const stored = await jsm.streams.getMessage(stream, { seq: first.seq });
      const decoded = parseDiscoveryEvent(new TextDecoder().decode(stored!.data));
      expect(decoded.id).toBe(event.id);
      expect(decoded.data?.ingestionReason).toBe("backfill");

      // A subject with no stream gets no acknowledgment and fails after bounded retries.
      const orphan = new NatsDiscoveryPublisher(nats, {
        subject: `${subject}.unbound`,
        maxAttempts: 2,
        retryDelayMs: 10,
        timeoutMs: 500,
      });
      await expect(orphan.publish(event)).rejects.toBeInstanceOf(NatsPublishError);

      // An expectation mismatch is rejected by the server and not retried.
      const wrongStream = new NatsDiscoveryPublisher(nats, {
        subject,
        expectStream: `${stream}_OTHER`,
      });
      await expect(wrongStream.publish(event)).rejects.toMatchObject({ code: "rejected" });
    } finally {
      const jsm = await nats.manager().catch(() => undefined);
      await jsm?.streams.delete(stream).catch(() => undefined);
      await nats.close();
      await nats.close();
    }
  }, 30_000);
});
