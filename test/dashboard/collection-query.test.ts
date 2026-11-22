import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  collectionQueryFromParams,
  CollectionQueryError,
  queryCollection,
  renderCollectionPage,
  validateCollectionQuery,
  type CollectionAdapter,
  type CollectionPage,
  type CollectionQuery,
} from "../../src/dashboard/collection-query.js";

// Synthetic adapters only: proves one contract serves two collections.
const artifact = (path: string) => ({
  repository: "content",
  commit: "a".repeat(40),
  path,
  hash: `sha256:${"b".repeat(64)}`,
});

function adapter(name: string, rows: Array<{ id: string; summary: string }>, calls: CollectionQuery[] = []): CollectionAdapter {
  return {
    name,
    filters: { post: { schema: z.string().regex(/^[a-z0-9-]{1,40}$/), description: "post id" } },
    sorts: ["recent", "title"],
    async search(query): Promise<CollectionPage> {
      calls.push(query);
      return {
        rows: rows.map((r) => ({ ...r, artifact: artifact(`${name}/${r.id}.json`) })),
        next: "cursor-2",
        limitations: [],
      };
    },
  };
}

describe("shared collection query (#617)", () => {
  it("parses a URL into a bounded query and namespaces filters", () => {
    const raw = collectionQueryFromParams(new URL("https://x/themes?q=weather&f.post=p1&sort=title&dir=asc&limit=200&after=c1"));
    expect(raw).toMatchObject({ text: "weather", filters: { post: "p1" }, sort: "title", direction: "asc" });
    const query = validateCollectionQuery(adapter("themes", []), raw);
    // The limit is capped rather than rejected.
    expect(query.limit).toBe(100);
    expect(query.cursor).toBe("c1");
  });

  it("refuses unknown filters and sorts instead of ignoring them", () => {
    const a = adapter("themes", []);
    expect(() => validateCollectionQuery(a, { filters: { bogus: "x" } })).toThrow(CollectionQueryError);
    expect(() => validateCollectionQuery(a, { sort: "secret" })).toThrow(/unknown-sort/);
    expect(() => validateCollectionQuery(a, { limit: "0" })).toThrow(/invalid-limit/);
    // A filter the collection publishes but whose value is wrong is refused too.
    expect(() => validateCollectionQuery(a, { filters: { post: "!!" } })).toThrow(/invalid-filter/);
  });

  it("serves two different collections through the same contract", async () => {
    const themeCalls: CollectionQuery[] = [];
    const claimCalls: CollectionQuery[] = [];
    const themes = await queryCollection(
      adapter("themes", [{ id: "t1", summary: "Geoengineering" }], themeCalls),
      { text: "geo" },
    );
    const claims = await queryCollection(
      adapter("claims", [{ id: "c1", summary: "A payment funded an attack" }], claimCalls),
      { text: "payment" },
    );
    expect(themes.rows[0]).toMatchObject({ id: "t1", summary: "Geoengineering" });
    expect(claims.rows[0]).toMatchObject({ id: "c1" });
    expect(themes.next).toBe("cursor-2");
    expect(themeCalls[0]).toMatchObject({ text: "geo", sort: "recent", direction: "desc" });
    expect(claimCalls[0]).toMatchObject({ text: "payment" });
  });

  it("refuses an adapter that overruns the page bound instead of dropping rows", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, summary: `Theme ${i}` }));
    await expect(queryCollection(adapter("themes", many), { limit: 5 })).rejects.toMatchObject({
      code: "adapter-overflow",
    });
  });

  it("rejects inherited property names as filters", () => {
    const a = adapter("themes", []);
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      expect(() => validateCollectionQuery(a, { filters: { [key]: "x" } })).toThrow(/unknown-filter/);
    }
    // `__proto__` can only arrive as a URL param; it must not become a filter.
    const raw = collectionQueryFromParams(new URL("https://x/themes?f.__proto__=x"));
    expect(() => validateCollectionQuery(a, raw)).toThrow(/unknown-filter/);
  });

  it("escapes rendered summaries and shows the exact artifact", () => {
    const html = renderCollectionPage({
      rows: [{ id: "t1", summary: "<script>x</script>", artifact: artifact("themes/t1.json"), limitations: ["scan bounded"] }],
      limitations: ["partial scan"],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("themes/t1.json");
    expect(html).toContain("partial scan");
  });
});
