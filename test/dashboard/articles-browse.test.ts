import { describe, expect, it } from "vite-plus/test";
import { articlesBrowseViews } from "../../src/dashboard/articles-browse-views.js";
import { articlesCollection } from "../../src/dashboard/articles-collection.js";
import { queryCollection } from "../../src/dashboard/collection-query.js";
import type { DraftEntry, DraftInventoryPort } from "../../src/dashboard/drafts.js";

const entry = (n: number, over: Partial<DraftEntry> = {}): DraftEntry => ({
  path: `articles/pub/p${n}/${String(n).padStart(32, "0")}.json`,
  publicationId: "pub",
  postId: `p${n}`,
  status: "unverified",
  title: `Article ${n}`,
  receipts: [],
  ...over,
});

/** Drafts reader stand-in: fixed pages of entries. */
function inventory(pages: DraftEntry[][]): DraftInventoryPort {
  return {
    async page({ after, publicationId }) {
      const i = after ? Number(after) : 0;
      const entries = (pages[i] ?? []).filter(
        (e) => !publicationId || e.publicationId === publicationId,
      );
      return { entries, ...(i + 1 < pages.length ? { next: String(i + 1) } : {}) };
    },
    async text() {
      return undefined;
    },
    async article() {
      return undefined;
    },
  };
}
const content = {
  lookup: async (path: string) => ({
    repository: "content",
    commit: "c".repeat(40),
    path,
    sha256: "d".repeat(64),
  }),
};

describe("article search (#621)", () => {
  it("shows one row per logical article at its current version, history kept separately", async () => {
    const drafts = inventory([
      [
        entry(1, { article: { id: "article-a", version: 1, current: false } }),
        entry(2, {
          article: { id: "article-a", version: 2, current: true },
          status: "approved",
          approvalScope: "publication",
        }),
        entry(3),
      ],
    ]);
    const page = await queryCollection(articlesCollection(drafts, content), {});
    expect(page.rows.map((r) => r.id)).toEqual(["article-a"]);
    expect(page.rows[0]).toMatchObject({ approval: "approved", article: { version: 2 } });
    const legacy = await queryCollection(articlesCollection(drafts, content), {
      filters: { category: "legacy-draft" },
    });
    expect(legacy.rows.map((r) => r.summary)).toEqual(["Article 3"]);
  });

  it("keeps body-only approval distinct, so changed metadata never reads as approved", async () => {
    const drafts = inventory([
      [
        entry(1, {
          article: { id: "a1", version: 1, current: true },
          status: "approved",
          approvalScope: "body-only",
        }),
        entry(2, {
          article: { id: "a2", version: 1, current: true },
          status: "approved",
          approvalScope: "publication",
        }),
      ],
    ]);
    const approved = await queryCollection(articlesCollection(drafts, content), {
      filters: { approval: "approved" },
    });
    expect(approved.rows.map((r) => r.id)).toEqual(["a2"]);
    const html = await articlesBrowseViews(drafts, content)[0]!.render(
      new URL("https://d.test/drafts/search"),
    );
    expect(html).toContain("body approved; title/subtitle/excerpt not approved");
  });

  it("filters by text and publication, and pages across reader pages without skipping", async () => {
    const pages = [
      [1, 2, 3].map((n) => entry(n, { article: { id: `a${n}`, version: 1, current: true } })),
      [4, 5].map((n) => entry(n, { article: { id: `a${n}`, version: 1, current: true } })),
    ];
    const adapter = articlesCollection(inventory(pages), content);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await queryCollection(adapter, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.next;
      if (!cursor) break;
    }
    expect(seen).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    const text = await queryCollection(adapter, { text: "article 2" });
    expect(text.rows.map((r) => r.id)).toEqual(["a2"]);
  });

  it("escapes hostile titles, refuses unknown filters and reports a foreign cursor", async () => {
    const drafts = inventory([
      [
        entry(1, {
          title: '<script>alert("x")</script>',
          article: { id: "a1", version: 1, current: true },
        }),
      ],
    ]);
    const render = (path: string) =>
      articlesBrowseViews(drafts, content)[0]!.render(new URL(`https://d.test${path}`));
    const html = await render("/drafts/search");
    expect(html).not.toContain("<script>alert");
    expect(await render("/drafts/search?f.__proto__=x")).toContain("not valid");
    const page = await queryCollection(articlesCollection(drafts, content), { cursor: "bogus" });
    expect(page.limitations.join(" ")).toMatch(/not valid for this list/);
  });
});
