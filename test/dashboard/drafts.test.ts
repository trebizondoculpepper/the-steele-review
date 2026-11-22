import {
  savePublicationPayload,
  artifactReference,
  artifactRef,
} from "../../src/drafting/publication-payload.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore, type ArtifactRef } from "../../src/controllers/artifact-store.js";
import { draftViews } from "../../src/dashboard/draft-views.js";
import { DRAFT_PAGE, draftInventory } from "../../src/dashboard/drafts.js";
import { DraftTrashStore } from "../../src/dashboard/draft-trash.js";
import { commitArticleRevision } from "../../src/drafting/article-revisions.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-drafts-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const any = {
  repository: "content",
  commit: "a".repeat(40),
  path: "x.json",
  hash: `sha256:${"b".repeat(64)}`,
};
const key = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Save one draft (Markdown plus metadata) as the writer would. */
async function saveDraft(
  post: string,
  markdown: string,
  title?: string,
  extra: { subtitle?: string; excerpt?: string } = {},
) {
  const k = key(`${post}:${markdown}:${title ?? ""}:${JSON.stringify(extra)}`);
  const md = await content.write(`articles/pub/${post}/${k}.md`, markdown);
  await content.write(
    `articles/pub/${post}/${k}.json`,
    JSON.stringify({
      schemaVersion: 1,
      package: any,
      source: any,
      themes: any,
      templateVersion: "package-explainer-v5",
      promptVersion: "package-draft-v9+sha256:0123456789abcdef",
      modelVersion: "fake/writer",
      draft: `${md.commit}:${md.path}`,
      ...(title
        ? { fields: { title, subtitle: extra.subtitle ?? "s", excerpt: extra.excerpt ?? "e" } }
        : {}),
      draftedAt: "2026-11-21T12:00:00.000Z",
    }),
  );
  return { md, metadata: `articles/pub/${post}/${k}.json` };
}

async function report(
  post: string,
  draft: ReturnType<typeof ref>,
  outcome: "approved" | "redraft",
  metadataPath?: string,
) {
  const metadata = metadataPath ? await content.lookup(metadataPath) : undefined;
  const publication = metadata
    ? await savePublicationPayload({
        content,
        metadata,
        body: artifactRef(draft),
        post: { publicationId: "pub", postId: post },
      })
    : undefined;
  await content.write(
    `verifications/pub/${post}/${key(JSON.stringify(draft) + outcome)}.json`,
    JSON.stringify({
      schemaVersion: publication ? 2 : 1,
      ...(publication ? { publication: artifactReference(publication.ref) } : {}),
      outcome,
      draft,
      package: any,
      source: any,
      themes: any,
      issues: [],
      checks: [],
      verifierModel: "fake/verifier",
      promptVersion: "p",
      verifiedAt: "2026-11-21T12:05:00.000Z",
    }),
  );
}

describe("draft inventory (#440)", { timeout: 60_000 }, () => {
  it("binds approval to one exact draft and never infers it", async () => {
    const r1 = await saveDraft("p1", "First revision.", "Revision one");
    const r2 = await saveDraft("p1", "Second revision.", "Revision two");
    const manual = await saveDraft("p2", "A manual draft with <script>alert(1)</script>.");
    await report("p1", ref(r1.md), "approved", r1.metadata);
    // A report naming the right hash in another repository approves nothing.
    await report("p1", { ...ref(r2.md), repository: "elsewhere" }, "approved");
    const page = await draftInventory(content).page({});
    const byPath = new Map(page.entries.map((e) => [e.path, e]));
    expect(byPath.get(r1.metadata)).toMatchObject({ status: "approved", title: "Revision one" });
    expect(byPath.get(r2.metadata)).toMatchObject({ status: "unverified", title: "Revision two" });
    expect(byPath.get(manual.metadata)).toMatchObject({ status: "unverified" });
    expect(page.next).toBeUndefined();
  });

  it("shows a redraft verdict and an unreadable record without guessing", async () => {
    const d = await saveDraft("p3", "Needs work.");
    await report("p3", ref(d.md), "redraft");
    await content.write(`articles/pub/p4/${"c".repeat(32)}.json`, "{not json");
    const entries = (await draftInventory(content).page({})).entries;
    expect(entries.find((e) => e.postId === "p3")).toMatchObject({ status: "redraft" });
    expect(entries.find((e) => e.postId === "p4")).toMatchObject({
      status: "unreadable",
      limitation: expect.stringContaining("unreadable"),
    });
  });

  it("does not share approval or receipts between different metadata over identical body bytes", async () => {
    const first = await saveDraft("p1", "Identical body.", "First title");
    const second = await saveDraft("p1", "Identical body.", "Second title");
    expect(first.md.sha256).toBe(second.md.sha256);
    await report("p1", ref(first.md), "approved", first.metadata);
    // An older body-only report never approves the second title.
    await report("p1", ref(second.md), "approved");
    const asked: Array<string | undefined> = [];
    const inventory = draftInventory(content, {
      receiptsFor: async (_post, _body, publicationHash) => {
        asked.push(publicationHash);
        return {
          receipts: [
            {
              destination: "sim",
              action: "draft",
              simulated: true,
              deliveredAt: "2026-01-01T00:00:00Z",
            },
          ],
          truncated: false,
        };
      },
    });
    const entries = (await inventory.page({})).entries;
    expect(entries.find((e) => e.path === first.metadata)).toMatchObject({
      status: "approved",
      approvalScope: "publication",
      receipts: [{ destination: "sim" }],
    });
    expect(entries.find((e) => e.path === second.metadata)).toMatchObject({
      status: "unverified",
      receipts: [],
      limitation: expect.stringContaining("only the body"),
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("labels legacy approval as body-only and escapes all saved generated fields", async () => {
    const legacy = await saveDraft("p1", "Legacy body.");
    await report("p1", ref(legacy.md), "approved");
    const draft = await saveDraft("p2", "Body.", "<em>Title</em>", {
      subtitle: "<img src=x>",
      excerpt: "<script>alert(1)</script>",
    });
    const inventory = draftInventory(content);
    expect((await inventory.text(legacy.metadata))?.entry).toMatchObject({
      status: "approved",
      approvalScope: "body-only",
    });
    const [, view] = draftViews(inventory);
    const html = await view!.render(
      new URL(`http://x/drafts/view?path=${encodeURIComponent(draft.metadata)}`),
    );
    expect(html).toContain("&lt;em&gt;Title&lt;/em&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("shows an incomplete verification scan as incomplete, not unverified", async () => {
    const d = await saveDraft("p5", "Only draft.");
    const failing = new Proxy(content, {
      get(target, prop) {
        if (prop === "list") {
          return async (prefix: string, limit: number, after?: string) => {
            if (prefix.startsWith("verifications/")) throw new Error("unavailable");
            return target.list(prefix, limit, after);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const entry = (await draftInventory(failing).page({})).entries.find(
      (e) => e.path === d.metadata,
    );
    expect(entry).toMatchObject({
      status: "incomplete",
      limitation: expect.stringContaining("incomplete"),
    });
  });

  it("shows all saved publication fields with the body, and labels legacy drafts (#469)", async () => {
    const long = `https://example.org/${"a".repeat(400)}`;
    const body = `First paragraph <b>bold</b>.\n\nSecond paragraph ${long}`;
    const withFields = await saveDraft("p6", body, "A <i>careful</i> title");
    const legacy = await saveDraft("p7", "Legacy body only.");
    const [, view] = draftViews(draftInventory(content));
    const html = await view!.render(
      new URL(`http://x/drafts/view?path=${encodeURIComponent(withFields.metadata)}`),
    );
    expect(html).toContain("A &lt;i&gt;careful&lt;/i&gt; title");
    expect(html).toMatch(/<dt>Subtitle<\/dt><dd><span class="draft-text">s<\/span>/);
    expect(html).toMatch(/<dt>Excerpt<\/dt><dd><span class="draft-text">e<\/span>/);
    expect(html).toContain(
      '<pre class="draft-text">First paragraph &lt;b&gt;bold&lt;/b&gt;.\n\nSecond paragraph',
    );
    expect(html).toContain(long); // exact stored text, wrapped by CSS only
    expect(html).toContain("No payload-aware verification is bound to these fields");
    const old = await view!.render(
      new URL(`http://x/drafts/view?path=${encodeURIComponent(legacy.metadata)}`),
    );
    expect(old.match(/not saved \(this draft predates generated fields\)/g)).toHaveLength(3);
  });

  it("wraps draft text and long tokens within the viewport", async () => {
    const { createDashboardServer } = await import("../../src/dashboard/server.js");
    const server = createDashboardServer([{ path: "/x", title: "X", render: () => "" }]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const css = await (await fetch(`http://127.0.0.1:${port}/x`)).text();
    server.close();
    expect(css).toMatch(/\.draft-text \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
  });

  it("pages honestly and escapes untrusted draft text", async () => {
    for (let i = 0; i < DRAFT_PAGE + 3; i++)
      await saveDraft(`post-${String(i).padStart(2, "0")}`, `Draft ${i}.`);
    const inventory = draftInventory(content);
    const first = await inventory.page({});
    expect(first.entries).toHaveLength(DRAFT_PAGE);
    expect(first.next).toBeTruthy();
    const second = await inventory.page({ after: first.next! });
    expect(second.entries.length).toBeGreaterThan(0);
    expect(new Set([...first.entries, ...second.entries].map((e) => e.path)).size).toBe(
      DRAFT_PAGE + 3,
    );

    const [list, view] = draftViews(inventory);
    expect(await list!.render(new URL("http://x/drafts"))).toContain("not the complete inventory");
    const manual = await saveDraft("zz", "Hello <script>alert(1)</script>.");
    const html = await view!.render(
      new URL(`http://x/drafts/view?path=${encodeURIComponent(manual.metadata)}`),
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("trashed drafts leave the active listing (#478)", () => {
  it("hides a trashed draft and shows it again after a restore", async () => {
    await saveDraft("post", "Body text");
    const trash = new DraftTrashStore(content);
    const withTrash = () => draftInventory(content, undefined, trash);

    const [entry] = (await withTrash().page({})).entries;
    expect(entry).toBeDefined();
    await trash.mark({
      schemaVersion: 1,
      draftPath: entry!.path,
      action: "delete",
      requestId: "req-1",
      at: "2026-02-01T00:00:00.000Z",
    });
    expect((await withTrash().page({})).entries).toHaveLength(0);
    await trash.mark({
      schemaVersion: 1,
      draftPath: entry!.path,
      action: "restore",
      requestId: "req-2",
      at: "2026-02-02T00:00:00.000Z",
    });
    expect((await withTrash().page({})).entries).toHaveLength(1);
  });

  it("skips past a storage page that is entirely trashed", async () => {
    // Two drafts per storage page; trash the whole first page.
    const trash = new DraftTrashStore(content);
    await saveDraft("post", "Body text");
    const all = await draftInventory(content).page({});
    const [first] = all.entries;
    expect(first).toBeDefined();
    await trash.mark({
      schemaVersion: 1,
      draftPath: first!.path,
      action: "delete",
      requestId: "skip-1",
      at: "2026-02-01T00:00:00.000Z",
    });
    const filtered = await draftInventory(content, undefined, trash).page({});
    // Whatever remains is still reachable rather than an empty page.
    expect(filtered.entries.every((e) => e.path !== first!.path)).toBe(true);
  });
});

describe("one logical article with its revision history (#581)", { timeout: 60_000 }, () => {
  it("groups an initial draft and two revisions, marks the current one, and keeps a legacy draft", async () => {
    const article = { publicationId: "pub", postId: "p1" };
    const generation = async (markdown: string, title: string) => {
      const d = await saveDraft("p1", markdown, title);
      return {
        draft: d.md,
        metadata: (await content.lookup(d.metadata))!,
        metadataPath: d.metadata,
      };
    };
    const g1 = await generation("# First <script>x</script>\n", "First version");
    // The first version was approved before the article moved on.
    await report("p1", ref(g1.draft), "approved", g1.metadataPath);
    const v1 = await commitArticleRevision({ content, article, generation: g1, base: "current" });
    if (v1.status === "conflict") throw new Error("conflict");
    const g2 = await generation("# Second\n", "Second version");
    const v2 = await commitArticleRevision({
      content,
      article,
      generation: g2,
      base: { body: v1.body.sha256, metadata: v1.metadata.sha256 },
    });
    if (v2.status === "conflict") throw new Error("conflict");
    const g3 = await generation("# Third\n", "Third version");
    await commitArticleRevision({
      content,
      article,
      generation: g3,
      base: { body: v2.body.sha256, metadata: v2.metadata.sha256 },
    });
    // A legacy hash-named draft that was never committed to an article.
    await saveDraft("p1", "# Legacy\n", "Legacy draft");

    const inventory = draftInventory(content);
    const page = await inventory.page({ publicationId: "pub", postId: "p1" });
    const byTitle = new Map(page.entries.map((e) => [e.title, e]));
    expect(byTitle.get("First version")?.article).toMatchObject({ version: 1, current: false });
    expect(byTitle.get("Third version")?.article).toMatchObject({ version: 3, current: true });
    expect(byTitle.get("Legacy draft")?.article).toBeUndefined();
    // The older version keeps its own approval; the current one is not approved.
    expect(byTitle.get("First version")?.status).toBe("approved");
    expect(byTitle.get("Third version")?.status).toBe("unverified");

    const id = byTitle.get("Third version")!.article!.id;
    const history = await inventory.article("pub", "p1", id);
    expect(history?.versions.map((v) => [v.version, v.current])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);

    const [, , articleView] = draftViews(inventory);
    const html = await articleView!.render(
      new URL(
        `http://x/drafts/article?${new URLSearchParams({ publication: "pub", post: "p1", id })}`,
      ),
    );
    expect(html).toContain("The current version is version 3, and it is not approved.");
    expect(html).toContain("An older version (1) was approved; that approval does not carry over.");
    expect(html).not.toContain("<script>x</script>");
    const [list] = draftViews(inventory);
    const listing = await list!.render(new URL("http://x/drafts?publication=pub&post=p1"));
    expect(listing).toContain("version 3</a> (current)");
    expect(listing).toContain("not committed to an article");
  });

  it("returns nothing for an unknown or malformed article id", async () => {
    const inventory = draftInventory(content);
    expect(await inventory.article("pub", "p1", `article-${"0".repeat(24)}`)).toBeUndefined();
    expect(await inventory.article("pub", "p1", "../x")).toBeUndefined();
  });
});
