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
