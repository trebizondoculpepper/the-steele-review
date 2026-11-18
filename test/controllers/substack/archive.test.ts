import { describe, expect, it } from "vite-plus/test";
import {
  IncompleteEnumerationError,
  SubstackArchiveDiscovery,
  normaliseArchivePost,
  type EnumerationSummary,
  type HistoricalOptions,
} from "../../../src/controllers/substack/archive.js";
import type { SubstackItem } from "../../../src/content/substack-item.js";

// Synthetic archive: 7 posts, one per day, newest first.
const post = (n: number) => ({
  id: 1000 + n,
  slug: `post-${n}`,
  canonical_url: `https://example-pub.substack.com/p/post-${n}`,
  title: `Synthetic post ${n}`,
  post_date: new Date(Date.UTC(2026, 0, 10 - n)).toISOString(),
  type: "podcast",
});
const POSTS = Array.from({ length: 7 }, (_, i) => post(i));

type Page = { posts: unknown[]; nextCursor?: string | null };
/** Serve pages keyed by cursor ("" for the first page). */
function archiveFetch(pages: Record<string, Page | number>) {
  const calls: URL[] = [];
  const fetch = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    calls.push(url);
    const page = pages[url.searchParams.get("cursor") ?? ""];
    if (page === undefined) return new Response("{}", { status: 400 });
    if (typeof page === "number") return new Response("", { status: page });
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const paged: Record<string, Page> = {
  "": { posts: POSTS.slice(0, 3), nextCursor: "c1" },
  c1: { posts: POSTS.slice(3, 6), nextCursor: "c2" },
  c2: { posts: POSTS.slice(6), nextCursor: null },
};

function controller(pages: Record<string, Page | number>, sleeps: number[] = []) {
  const fake = archiveFetch(pages);
  const discovery = new SubstackArchiveDiscovery({
    publicationUrl: "https://example-pub.substack.com/",
    publicationId: "example-pub",
    pageSize: 3,
    minRequestIntervalMs: 50,
    retryDelayMs: 1,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { discovery, calls: fake.calls };
}

async function run(
  discovery: SubstackArchiveDiscovery,
  options: Omit<HistoricalOptions, "onComplete">,
): Promise<{ items: SubstackItem[]; summary?: EnumerationSummary }> {
  const items: SubstackItem[] = [];
  let summary: EnumerationSummary | undefined;
  for await (const item of discovery.getHistoricalItems({
    ...options,
    onComplete: (s) => (summary = s),
  })) {
    items.push(item);
  }
  return { items, summary };
}

describe("normaliseArchivePost", () => {
  it("maps slug, canonical URL, title and date", () => {
    expect(normaliseArchivePost(post(1), "example-pub")).toEqual({
      publicationId: "example-pub",
      postId: "post-1",
      url: "https://example-pub.substack.com/p/post-1",
      title: "Synthetic post 1",
      publishedAt: "2026-01-09T00:00:00.000Z",
    });
  });

  it("omits a missing date and skips unusable entries", () => {
    expect(normaliseArchivePost({ ...post(1), post_date: null }, "example-pub")).not.toHaveProperty(
      "publishedAt",
    );
    expect(normaliseArchivePost({ ...post(1), canonical_url: undefined }, "example-pub")).toEqual({
      skip: "entry has no canonical post URL",
    });
    expect(normaliseArchivePost({ ...post(1), title: "" }, "example-pub")).toHaveProperty("skip");
    expect(normaliseArchivePost("nonsense", "example-pub")).toHaveProperty("skip");
  });
});

describe("SubstackArchiveDiscovery", () => {
  it("follows cursors to the end and reports exhaustion", async () => {
    const sleeps: number[] = [];
    const { discovery, calls } = controller(paged, sleeps);
    const { items, summary } = await run(discovery, { maxItems: 100 });
    expect(items.map((i) => i.postId)).toEqual(POSTS.map((p) => p.slug));
    expect(summary).toMatchObject({ reason: "exhausted", pages: 3, emitted: 7 });
    expect(calls.map((u) => u.searchParams.get("cursor"))).toEqual([null, "c1", "c2"]);
    expect(calls[0]!.searchParams.get("limit")).toBe("3");
    expect(sleeps).toEqual([50, 50]);
  });

  it("stops at the count bound without fetching further pages", async () => {
    const { discovery, calls } = controller(paged);
    const { items, summary } = await run(discovery, { maxItems: 2 });
    expect(items).toHaveLength(2);
    expect(summary?.reason).toBe("count-limit");
    expect(calls).toHaveLength(1);
  });

  it("applies inclusive since/until date bounds", async () => {
    const { discovery } = controller(paged);
    const { items, summary } = await run(discovery, {
      maxItems: 100,
      until: new Date("2026-01-08T00:00:00Z"),
      since: new Date("2026-01-06T00:00:00Z"),
    });
    expect(items.map((i) => i.postId)).toEqual(["post-2", "post-3", "post-4"]);
    expect(summary?.reason).toBe("date-limit");
  });

  it("requires a positive count bound and ordered dates", async () => {
    const { discovery } = controller(paged);
    await expect(run(discovery, { maxItems: 0 })).rejects.toThrow();
    await expect(
      run(discovery, {
        maxItems: 1,
        since: new Date("2026-02-01T00:00:00Z"),
        until: new Date("2026-01-01T00:00:00Z"),
      }),
    ).rejects.toThrow(RangeError);
  });

  it("suppresses items repeated across pages", async () => {
    const { discovery } = controller({
      "": { posts: POSTS.slice(0, 3), nextCursor: "c1" },
      c1: { posts: POSTS.slice(2, 5), nextCursor: null },
    });
    const { items, summary } = await run(discovery, { maxItems: 100 });
    expect(items.map((i) => i.postId)).toEqual(["post-0", "post-1", "post-2", "post-3", "post-4"]);
    expect(summary).toMatchObject({ reason: "exhausted", duplicates: 1 });
  });

  it("reports a repeated cursor as incomplete rather than looping", async () => {
    const { discovery } = controller({
      "": { posts: POSTS.slice(0, 3), nextCursor: "c1" },
      c1: { posts: POSTS.slice(3, 6), nextCursor: "c1" },
    });
    await expect(run(discovery, { maxItems: 100 })).rejects.toThrow("repeated a page cursor");
  });

  it("reports interrupted enumeration with progress", async () => {
    const { discovery } = controller({ "": paged[""]!, c1: 500 });
    const items: SubstackItem[] = [];
    let error: unknown;
    try {
      for await (const item of discovery.getHistoricalItems({ maxItems: 100 })) items.push(item);
    } catch (e) {
      error = e;
    }
    expect(items).toHaveLength(3);
    expect(error).toBeInstanceOf(IncompleteEnumerationError);
    expect((error as IncompleteEnumerationError).summary).toMatchObject({ pages: 1, emitted: 3 });
    expect((error as Error).message).not.toContain("example-pub");
  });

  it("reports an unexpected page shape as incomplete", async () => {
    const { discovery } = controller({ "": { posts: "nope" } as unknown as Page });
    await expect(run(discovery, { maxItems: 5 })).rejects.toThrow("unexpected shape");
  });

  it("honours cancellation", async () => {
    const abort = new AbortController();
    const { discovery } = controller(paged);
    const items: SubstackItem[] = [];
    await expect(
      (async () => {
        for await (const item of discovery.getHistoricalItems({
          maxItems: 100,
          signal: abort.signal,
        })) {
          items.push(item);
          abort.abort();
        }
      })(),
    ).rejects.toBeInstanceOf(IncompleteEnumerationError);
    expect(items).toHaveLength(1);
  });

  it("validates page size against the archive limit", () => {
    expect(
      () =>
        new SubstackArchiveDiscovery({
          publicationUrl: "https://example-pub.substack.com/",
          publicationId: "example-pub",
          pageSize: 50,
        }),
    ).toThrow();
  });
});

// Bounded live check; runs only when explicitly configured.
const liveUrl = process.env.STEELE_LIVE_PUBLICATION_URL;
const livePublication = process.env.STEELE_LIVE_PUBLICATION_ID;
describe.skipIf(!liveUrl || !livePublication)("live archive smoke test", () => {
  it("enumerates items older than the RSS window", async () => {
    const discovery = new SubstackArchiveDiscovery({
      publicationUrl: liveUrl!,
      publicationId: livePublication!,
      minRequestIntervalMs: 1_000,
      maxPages: 3,
    });
    const { items, summary } = await run(discovery, {
      maxItems: 60,
      signal: AbortSignal.timeout(60_000),
    });
    expect(summary?.reason).toBe("count-limit");
    expect(items).toHaveLength(60);
    expect(new Set(items.map((i) => i.postId)).size).toBe(60);
  }, 90_000);
});
