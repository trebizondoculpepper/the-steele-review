import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  FeedParseError,
  SubstackRssDiscovery,
  parseFeed,
} from "../../../src/controllers/substack/rss.js";
import { DiscoveryFetchError } from "../../../src/controllers/substack/http.js";
import { SubstackItemSchema, type SubstackItem } from "../../../src/content/substack-item.js";

const FEED_URL = "https://example-pub.substack.com/feed";
const xml = readFileSync(new URL("./fixtures/feed.xml", import.meta.url), "utf8");

async function collect(iterable: AsyncIterable<SubstackItem>): Promise<SubstackItem[]> {
  const out: SubstackItem[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

type Handler = (url: URL) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: string[] = [];
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.href);
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    return await new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      Promise.resolve()
        .then(() => handler(url))
        .then(resolve, reject);
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const noSleep = async () => {};

function discovery(
  handler: Handler,
  extra: Partial<ConstructorParameters<typeof SubstackRssDiscovery>[0]> = {},
) {
  const fake = fakeFetch(handler);
  const controller = new SubstackRssDiscovery({
    feedUrl: FEED_URL,
    publicationId: "example-pub",
    fetch: fake.fetch,
    sleep: noSleep,
    ...extra,
  });
  return { controller, calls: fake.calls };
}

describe("parseFeed", () => {
  it("normalises every usable entry, preserving IDs and available dates", async () => {
    const skipped: string[] = [];
    const items = await parseFeed(xml, "example-pub", (reason) => skipped.push(reason));
    expect(items.map((i) => i.postId)).toEqual([
      "third-synthetic-post",
      "second-synthetic-post",
      "undated-synthetic-post",
    ]);
    expect(items[0]).toEqual({
      publicationId: "example-pub",
      postId: "third-synthetic-post",
      url: "https://example-pub.substack.com/p/third-synthetic-post",
      title: "Third synthetic post",
      publishedAt: "2026-02-02T09:00:00.000Z",
    });
    expect(items[2]).not.toHaveProperty("publishedAt");
    expect(items[2]).not.toHaveProperty("updatedAt");
    for (const item of items) expect(SubstackItemSchema.safeParse(item).success).toBe(true);
    expect(skipped).toHaveLength(2);
  });

  it("rejects a malformed feed", async () => {
    await expect(parseFeed("<rss><channel><item>", "example-pub")).rejects.toBeInstanceOf(
      FeedParseError,
    );
    await expect(parseFeed("not xml at all", "example-pub")).rejects.toBeInstanceOf(FeedParseError);
  });
});

describe("SubstackRssDiscovery", () => {
  it("fetches the feed and yields all entries, not only the newest", async () => {
    const { controller } = discovery(() => new Response(xml, { status: 200 }));
    expect(await collect(controller.getRecentItems())).toHaveLength(3);
  });

  it("retries transient failures a bounded number of times", async () => {
    let n = 0;
    const { controller, calls } = discovery(() =>
      ++n < 3 ? new Response("", { status: 503 }) : new Response(xml),
    );
    expect(await collect(controller.getRecentItems())).toHaveLength(3);
    expect(calls).toHaveLength(3);

    const failing = discovery(() => new Response("", { status: 503 }), { maxAttempts: 2 });
    await expect(collect(failing.controller.getRecentItems())).rejects.toThrow(
      "unexpected HTTP status 503",
    );
    expect(failing.calls).toHaveLength(2);
  });

  it("does not retry permanent failures", async () => {
    const { controller, calls } = discovery(() => new Response("", { status: 404 }));
    await expect(collect(controller.getRecentItems())).rejects.toBeInstanceOf(DiscoveryFetchError);
    expect(calls).toHaveLength(1);
  });

  it("follows allowed redirects and refuses others before fetching", async () => {
    const ok = discovery((url) =>
      url.pathname === "/feed"
        ? new Response(null, { status: 302, headers: { location: "/feed2" } })
        : new Response(xml),
    );
    expect(await collect(ok.controller.getRecentItems())).toHaveLength(3);

    const offsite = discovery(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/x" } }),
    );
    await expect(collect(offsite.controller.getRecentItems())).rejects.toThrow(
      "destination host is not allowed",
    );
    expect(offsite.calls).toEqual([FEED_URL]);

    const downgrade = discovery(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: "http://example-pub.substack.com/feed" },
        }),
    );
    await expect(collect(downgrade.controller.getRecentItems())).rejects.toThrow("HTTPS");
  });

  it("refuses a non-HTTPS feed URL without fetching", async () => {
    const { controller, calls } = discovery(() => new Response(xml), {
      feedUrl: "http://example-pub.substack.com/feed",
    });
    await expect(collect(controller.getRecentItems())).rejects.toThrow("HTTPS");
    expect(calls).toHaveLength(0);
  });

  it("enforces the response size limit", async () => {
    const { controller } = discovery(() => new Response(xml), { maxBytes: 100 });
    await expect(collect(controller.getRecentItems())).rejects.toThrow("size limit");
  });

  it("honours cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const { controller } = discovery(() => new Response(xml));
    await expect(collect(controller.getRecentItems(abort.signal))).rejects.toThrow("cancelled");
  });

  it("times out a slow response", async () => {
    const { controller } = discovery(
      (url) =>
        new Promise<Response>(() => {
          void url;
        }),
      { timeoutMs: 20, maxAttempts: 1 },
    );
    await expect(collect(controller.getRecentItems())).rejects.toThrow();
  }, 2_000);

  it("keeps the feed URL out of error messages", async () => {
    const { controller } = discovery(
      () => {
        throw new Error(`boom ${FEED_URL}`);
      },
      { maxAttempts: 1 },
    );
    await expect(collect(controller.getRecentItems())).rejects.toSatisfy(
      (e: Error) => !e.message.includes("example-pub"),
    );
  });

  it("validates the publication ID", () => {
    expect(
      () => new SubstackRssDiscovery({ feedUrl: FEED_URL, publicationId: "Bad ID" }),
    ).toThrow();
  });
});

// Bounded live check; runs only when explicitly configured.
const liveFeed = process.env.STEELE_LIVE_FEED_URL;
const livePublication = process.env.STEELE_LIVE_PUBLICATION_ID;
describe.skipIf(!liveFeed || !livePublication)("live feed smoke test", () => {
  it("reads at least one item from the configured public feed", async () => {
    const controller = new SubstackRssDiscovery({
      feedUrl: liveFeed!,
      publicationId: livePublication!,
      timeoutMs: 15_000,
      maxAttempts: 2,
    });
    const items = await collect(controller.getRecentItems(AbortSignal.timeout(30_000)));
    expect(items.length).toBeGreaterThan(0);
  }, 40_000);
});
