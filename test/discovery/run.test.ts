import { describe, expect, it } from "vite-plus/test";
import {
  runDiscovery,
  type DiscoveryPublisher,
  type DiscoveryRunInput,
} from "../../src/discovery/run.js";
import { createDiscoveryEvent, type DiscoveryEvent } from "../../src/events/discovery-event.js";
import type { SubstackItem } from "../../src/content/substack-item.js";

const item = (n: number): SubstackItem => ({
  publicationId: "example-pub",
  postId: `post-${n}`,
  url: `https://example-pub.substack.com/p/post-${n}`,
  title: `Synthetic post ${n}`,
});

async function* source(items: SubstackItem[], failAfter?: number) {
  let i = 0;
  for (const it of items) {
    if (failAfter !== undefined && i === failAfter) {
      throw new Error("source broke with https://private.example/secret");
    }
    i++;
    yield it;
  }
}

class FakePublisher implements DiscoveryPublisher {
  readonly published: DiscoveryEvent[] = [];
  readonly attempts: string[] = [];
  constructor(private readonly behaviour: (event: DiscoveryEvent, n: number) => void = () => {}) {}
  async publish(event: DiscoveryEvent): Promise<void> {
    this.attempts.push(event.id);
    this.behaviour(event, this.attempts.length);
    this.published.push(event);
  }
}

let seq = 0;
const createEvent: DiscoveryRunInput["createEvent"] = (it, options) =>
  createDiscoveryEvent(it, options, {
    newId: () => `id-${++seq}`,
    now: () => new Date("2026-02-01T00:00:00Z"),
  });

describe("runDiscovery", () => {
  it("publishes every item in order with a shared correlation ID", async () => {
    const publisher = new FakePublisher();
    const summary = await runDiscovery({
      source: source([item(1), item(2), item(3)]),
      reason: "live",
      createEvent,
      publisher,
      correlationId: "run-1",
    });
    expect(summary).toEqual({
      status: "complete",
      correlationId: "run-1",
      reason: "live",
      discovered: 3,
      published: 3,
    });
    expect(publisher.published.map((e) => e.data?.postId)).toEqual(["post-1", "post-2", "post-3"]);
    for (const e of publisher.published) {
      expect(e.correlationid).toBe("run-1");
      expect(e.data?.ingestionReason).toBe("live");
    }
  });

  it("completes with zero items", async () => {
    const summary = await runDiscovery({
      source: source([]),
      reason: "backfill",
      createEvent,
      publisher: new FakePublisher(),
    });
    expect(summary).toMatchObject({ status: "complete", discovered: 0, published: 0 });
    expect(summary.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports a source failure as partial without leaking its message", async () => {
    const publisher = new FakePublisher();
    const summary = await runDiscovery({
      source: source([item(1), item(2), item(3)], 2),
      reason: "backfill",
      createEvent,
      publisher,
    });
    expect(summary).toMatchObject({
      status: "failed",
      discovered: 2,
      published: 2,
      failure: { stage: "source", errorName: "Error" },
    });
    expect(JSON.stringify(summary)).not.toContain("private");
  });

  it("stops at a publish failure and leaves earlier events published", async () => {
    const publisher = new FakePublisher((_event, n) => {
      if (n === 2) throw new TypeError("broker down");
    });
    const summary = await runDiscovery({
      source: source([item(1), item(2), item(3)]),
      reason: "live",
      createEvent,
      publisher,
    });
    expect(summary).toMatchObject({
      status: "failed",
      discovered: 2,
      published: 1,
      failure: { stage: "publish", errorName: "TypeError" },
    });
    expect(publisher.attempts).toHaveLength(2);
  });

  it("hands one constructed event to the publisher so its retries keep the ID", async () => {
    const ids: string[] = [];
    const retrying: DiscoveryPublisher = {
      async publish(event) {
        // A publisher retrying internally resends the same object.
        ids.push(event.id, event.id);
      },
    };
    await runDiscovery({
      source: source([item(1)]),
      reason: "live",
      createEvent,
      publisher: retrying,
    });
    expect(new Set(ids).size).toBe(1);
  });

  it("reports an event construction failure", async () => {
    const summary = await runDiscovery({
      source: source([{ ...item(1), url: "http://insecure.test/p/x" }]),
      reason: "live",
      createEvent,
      publisher: new FakePublisher(),
    });
    expect(summary).toMatchObject({ status: "failed", failure: { stage: "event" } });
  });

  it("propagates cancellation and closes the source", async () => {
    const abort = new AbortController();
    let closed = false;
    async function* endless() {
      try {
        for (let n = 0; ; n++) yield item(n);
      } finally {
        closed = true;
      }
    }
    const publisher = new FakePublisher((_e, n) => {
      if (n === 2) abort.abort();
    });
    const summary = await runDiscovery({
      source: endless(),
      reason: "live",
      createEvent,
      publisher,
      signal: abort.signal,
    });
    expect(summary.status).toBe("cancelled");
    expect(summary.published).toBe(2);
    expect(summary).not.toHaveProperty("failure");
    expect(closed).toBe(true);
  });

  it("reports an aborted publish as cancelled, not failed", async () => {
    const abort = new AbortController();
    const publisher: DiscoveryPublisher = {
      async publish() {
        abort.abort();
        throw new Error("aborted");
      },
    };
    const summary = await runDiscovery({
      source: source([item(1)]),
      reason: "live",
      createEvent,
      publisher,
      signal: abort.signal,
    });
    expect(summary.status).toBe("cancelled");
    expect(summary.published).toBe(0);
  });
});
