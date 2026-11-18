import { describe, expect, it } from "vite-plus/test";
import {
  BackfillUsageError,
  MAX_BACKFILL_ITEMS,
  parseBackfillArgs,
  runBackfill,
  type HistoricalSource,
} from "../../src/discovery/backfill.js";
import {
  IncompleteEnumerationError,
  type HistoricalOptions,
} from "../../src/controllers/substack/archive.js";
import type { DiscoveryPublisher } from "../../src/discovery/run.js";
import { createDiscoveryEvent, type DiscoveryEvent } from "../../src/events/discovery-event.js";
import type { SubstackItem } from "../../src/content/substack-item.js";

const BASE = [
  "--publication-url",
  "https://example-pub.substack.com/",
  "--publication-id",
  "example-pub",
];
const item = (n: number): SubstackItem => ({
  publicationId: "example-pub",
  postId: `post-${n}`,
  url: `https://example-pub.substack.com/p/post-${n}`,
  title: `Post ${n}`,
});

describe("parseBackfillArgs", () => {
  it("parses explicit bounds", () => {
    expect(
      parseBackfillArgs([
        ...BASE,
        "--max-items",
        "50",
        "--since",
        "2025-01-01T00:00:00Z",
        "--until",
        "2025-06-30T23:59:59Z",
      ]),
    ).toEqual({
      publicationUrl: "https://example-pub.substack.com/",
      publicationId: "example-pub",
      maxItems: 50,
      since: new Date("2025-01-01T00:00:00Z"),
      until: new Date("2025-06-30T23:59:59Z"),
    });
  });

  it.each([
    [[...BASE], "maxItems"],
    [[...BASE, "--max-items", "0"], "maxItems"],
    [[...BASE, "--max-items=-3"], "maxItems"],
    [[...BASE, "--max-items", "lots"], "maxItems"],
    [[...BASE, "--max-items", String(MAX_BACKFILL_ITEMS + 1)], "maxItems"],
    [[...BASE, "--max-items", "5", "--since", "2025-01-01"], "since"],
    [["--publication-id", "example-pub", "--max-items", "5"], "publicationUrl"],
    [
      [
        "--publication-url",
        "http://example-pub.substack.com/",
        "--publication-id",
        "example-pub",
        "--max-items",
        "5",
      ],
      "publicationUrl",
    ],
    [
      [
        ...BASE,
        "--max-items",
        "5",
        "--since",
        "2025-06-01T00:00:00Z",
        "--until",
        "2025-01-01T00:00:00Z",
      ],
      "options",
    ],
  ])("rejects %j (%s) without echoing values", (argv, field) => {
    const error = (() => {
      try {
        parseBackfillArgs(argv);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(BackfillUsageError);
    expect((error as Error).message).toContain(field);
    expect((error as Error).message).not.toContain("example-pub.substack");
  });

  it("rejects unknown options", () => {
    expect(() => parseBackfillArgs([...BASE, "--max-items", "5", "--everything"])).toThrow(
      BackfillUsageError,
    );
  });
});

function source(items: SubstackItem[], end: "exhausted" | "count-limit" | Error) {
  const seen: HistoricalOptions[] = [];
  const s: HistoricalSource = {
    async *getHistoricalItems(options) {
      seen.push(options);
      for (const it of items.slice(0, options.maxItems)) yield it;
      if (end instanceof Error) throw end;
      options.onComplete?.({
        reason: end,
        pages: 1,
        emitted: items.length,
        duplicates: 0,
        skipped: 0,
      });
    },
  };
  return { s, seen };
}

function publisher(failAt?: number) {
  const events: DiscoveryEvent[] = [];
  const p: DiscoveryPublisher = {
    async publish(event) {
      if (events.length + 1 === failAt) throw new TypeError("broker down");
      events.push(event);
    },
  };
  return { p, events };
}

const options = {
  publicationUrl: "https://example-pub.substack.com/",
  publicationId: "example-pub",
  maxItems: 10,
};

describe("runBackfill", () => {
  it("publishes every item as a backfill event and succeeds on complete enumeration", async () => {
    const src = source([item(1), item(2)], "exhausted");
    const pub = publisher();
    const report = await runBackfill({
      options,
      source: src.s,
      createEvent: createDiscoveryEvent,
      publisher: pub.p,
    });
    expect(report).toMatchObject({
      ok: true,
      enumeration: "exhausted",
      discovered: 2,
      published: 2,
    });
    expect(pub.events.every((e) => e.data?.ingestionReason === "backfill")).toBe(true);
    expect(src.seen[0]).toMatchObject({ maxItems: 10 });
  });

  it("passes the bounds to the source", async () => {
    const src = source([], "exhausted");
    const since = new Date("2025-01-01T00:00:00Z");
    await runBackfill({
      options: { ...options, maxItems: 3, since },
      source: src.s,
      createEvent: createDiscoveryEvent,
      publisher: publisher().p,
    });
    expect(src.seen[0]).toMatchObject({ maxItems: 3, since });
  });

  it("supports rerunning an overlapping range with the same content identity", async () => {
    const first = publisher();
    const second = publisher();
    await runBackfill({
      options,
      source: source([item(1), item(2)], "exhausted").s,
      createEvent: createDiscoveryEvent,
      publisher: first.p,
    });
    await runBackfill({
      options,
      source: source([item(2), item(3)], "exhausted").s,
      createEvent: createDiscoveryEvent,
      publisher: second.p,
    });
    const overlap = second.events.find((e) => e.data?.postId === "post-2")!;
    const original = first.events.find((e) => e.data?.postId === "post-2")!;
    expect(overlap.subject).toBe(original.subject);
    expect(overlap.id).not.toBe(original.id);
  });

  it("fails when enumeration is incomplete, even after publishing some items", async () => {
    const report = await runBackfill({
      options,
      source: source(
        [item(1)],
        new IncompleteEnumerationError("archive repeated a page cursor", {
          pages: 1,
          emitted: 1,
          duplicates: 0,
          skipped: 0,
        }),
      ).s,
      createEvent: createDiscoveryEvent,
      publisher: publisher().p,
    });
    expect(report).toMatchObject({
      ok: false,
      published: 1,
      runStatus: "failed",
      failureStage: "source",
      failureError: "IncompleteEnumerationError",
    });
    expect(report.enumeration).toBeUndefined();
  });

  it("fails on a partial publish failure", async () => {
    const report = await runBackfill({
      options,
      source: source([item(1), item(2), item(3)], "exhausted").s,
      createEvent: createDiscoveryEvent,
      publisher: publisher(2).p,
    });
    expect(report).toMatchObject({ ok: false, published: 1, failureStage: "publish" });
  });

  it("honours cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const report = await runBackfill({
      options,
      source: source([item(1)], "exhausted").s,
      createEvent: createDiscoveryEvent,
      publisher: publisher().p,
      signal: abort.signal,
    });
    expect(report).toMatchObject({ ok: false, runStatus: "cancelled", published: 0 });
  });
});
