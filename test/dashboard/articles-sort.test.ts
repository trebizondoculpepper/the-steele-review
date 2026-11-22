import { describe, expect, it } from "vite-plus/test";
import { indexArticles } from "../../src/dashboard/adapters.js";
import { articleViews } from "../../src/dashboard/article-views.js";

const hit = (postId: string, sort: unknown[]) => ({
  source: {
    publicationId: "pub",
    postId,
    sourceVersion: `sha256:${"a".repeat(64)}`,
    publishedAt: "2026-02-01T00:00:00Z",
  },
  sort,
});

const searchWith = (hits: unknown[]) => {
  const calls: Array<{ size?: number; sort?: unknown; searchAfter?: unknown[] }> = [];
  return {
    calls,
    port: {
      search: async (_index: string, _query: unknown, options: Record<string, unknown>) => {
        calls.push(options as { size?: number; sort?: unknown; searchAfter?: unknown[] });
        return hits;
      },
    },
  };
};

describe("article paging and date sort (#508)", () => {
  it("orders newest or oldest by publication date with a stable tie-break", async () => {
    for (const [sort, order] of [
      ["newest", "desc"],
      ["oldest", "asc"],
    ] as const) {
      const { port, calls } = searchWith([hit("p1", ["2026-02-01T00:00:00Z", "pub", "p1"])]);
      const page = await indexArticles(port as never).page!({ sort, limit: 25 });
      expect(page.entries).toHaveLength(1);
      const esSort = calls[0]!.sort as Array<Record<string, { order: string }>>;
      expect(esSort[0]!.publishedAt!.order).toBe(order);
      // A date sentinel, not _last/_first: the latter is a 64-bit integer that
      // cannot round-trip through a JSON cursor for undated articles.
      const missing = (esSort[0] as unknown as { publishedAt: { missing: string } }).publishedAt
        .missing;
      expect(missing).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Number.isSafeInteger(Number(missing))).toBe(false);
      // Tie-break keeps a page boundary from repeating or skipping rows.
      expect(esSort[1]).toEqual({ publicationId: { order: "asc" } });
      expect(esSort[2]).toEqual({ postId: { order: "asc" } });
    }
  });

  it("round-trips an opaque cursor into search_after and stops when a page is short", async () => {
    const first = searchWith([hit("p1", ["2026-02-01T00:00:00Z", "pub", "p1"])]);
    const page = await indexArticles(first.port as never).page!({ sort: "newest", limit: 1 });
    expect(page.next).toBeDefined();

    const second = searchWith([hit("p2", ["2026-01-01T00:00:00Z", "pub", "p2"])]);
    // A short page means the listing is exhausted: no cursor offered.
    await indexArticles(second.port as never).page!({ sort: "newest", limit: 2, after: page.next });
    expect(second.calls[0]!.searchAfter).toEqual(["2026-02-01T00:00:00Z", "pub", "p1"]);
  });

  it("renders the sort toggle and a next-page link, and passes the sort to the port", async () => {
    const seen: string[] = [];
    const port = {
      recent: async () => [],
      find: async () => undefined,
      page: async ({ sort, after }: { sort: string; after?: string }) => {
        seen.push(`${sort}:${after ?? "-"}`);
        return { entries: [], next: "cursor-2" };
      },
    };
    const view = articleViews({ articles: port, canTrigger: false }).find(
      (v) => v.path === "/articles",
    )!;
    const html = await view.render(new URL("https://dashboard.test/articles?sort=oldest"));
    expect(seen).toEqual(["oldest:-"]);
    expect(html).toContain("oldest first");
    expect(html).toContain("sort=newest");
    expect(html).toContain("Next page");
    expect(html).toContain("after=cursor-2");
  });
});

describe("article search and publication filter (#509)", () => {
  it("matches plain words over title and text and filters by exact publication", async () => {
    const queries: unknown[] = [];
    const port = {
      search: async (_i: string, query: unknown) => {
        queries.push(query);
        return [];
      },
    };
    await indexArticles(port as never).page!({
      sort: "newest",
      limit: 25,
      query: '  mast "safety" OR x:* ',
      publicationId: "steeleworks",
    });
    expect(queries[0]).toEqual({
      bool: {
        must: [
          {
            multi_match: {
              query: 'mast "safety" OR x:*',
              fields: ["title^2", "text"],
              operator: "and",
            },
          },
        ],
        filter: [{ term: { publicationId: "steeleworks" } }],
      },
    });
    await indexArticles(port as never).page!({ sort: "newest", limit: 25 });
    expect(queries[1]).toEqual({ bool: { must: [{ match_all: {} }], filter: [] } });
  });

  it("carries search, publication, sort and status through the form and every link", async () => {
    const seen: unknown[] = [];
    const port = {
      recent: async () => [],
      find: async () => undefined,
      page: async (o: unknown) => {
        seen.push(o);
        return { entries: [], next: "c2" };
      },
    };
    const view = articleViews({ articles: port, canTrigger: false }).find(
      (v) => v.path === "/articles",
    )!;
    const html = await view.render(
      new URL(
        "https://dashboard.test/articles?q=mast%20%3Cb%3E&publication=steeleworks&sort=oldest",
      ),
    );
    expect(seen[0]).toMatchObject({
      sort: "oldest",
      query: "mast <b>",
      publicationId: "steeleworks",
    });
    expect(html).toContain('value="mast &lt;b&gt;"');
    expect(html).not.toContain("<b>");
    expect(html).toContain("No indexed articles match this search.");
    // Paging and sort links keep the search.
    expect(html).toMatch(/after=c2[^"]*|q=mast[^"]*after=c2/);
    expect(html).toContain("publication=steeleworks");
    // An invalid publication is ignored, never passed to the index.
    seen.length = 0;
    await view.render(new URL("https://dashboard.test/articles?publication=Bad%20Pub"));
    expect(seen[0]).not.toHaveProperty("publicationId");
  });
});
