import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { renderTrace } from "../../src/dashboard/article-views.js";
import { traceArticle } from "../../src/dashboard/articles.js";
import { savedThemes } from "../../src/dashboard/themes.js";
import { librarianFixtures } from "../research/librarian-fixtures.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-article-themes-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const claim = (id: string, statement: string) => [{ id, statement }];
const post = { publicationId: "pub", postId: "p1" };

describe("article theme links (#496)", { timeout: 60_000 }, () => {
  it("lists the saved proposals for that post with stable detail links", async () => {
    const fx = librarianFixtures(content);
    await fx.analysis("p1", claim("c1", "A treaty bans weather weapons"), "Weather warfare");
    const themes = savedThemes(content);
    const listing = await themes.list({});
    const row = listing.rows.find((r) => r.postId === "p1")!;

    const found = await themes.forPost(post, row.sourceVersion);
    expect(found.state).toBe("ok");
    expect(found.themes).toHaveLength(1);
    expect(found.themes[0]).toMatchObject({
      result: row.result,
      id: row.id,
      title: "Weather warfare",
      sourceVersion: row.sourceVersion,
    });

    const trace = await traceArticle({
      post,
      articles: {
        recent: async () => [],
        find: async () => ({ ...post, sourceVersion: row.sourceVersion }),
      },
      themes,
    });
    const html = renderTrace(trace);
    expect(html).toContain("Themes");
    expect(html).toContain(`/themes/view?result=${encodeURIComponent(row.result)}&amp;id=${encodeURIComponent(row.id)}`);
    expect(html).toContain("Weather warfare");
    expect(html).toContain("extractor proposal, not canonical");
  });

  it("does not link a different saved revision of the same post", async () => {
    const fx = librarianFixtures(content);
    await fx.analysis("p1", claim("c1", "A treaty bans weather weapons"), "Weather warfare");
    const themes = savedThemes(content);
    const other = await themes.forPost(post, `sha256:${"a".repeat(64)}`);
    expect(other).toEqual({ state: "not-analysed", themes: [] });
  });

  it("reports an analysed post with no proposals and a missing analysis distinctly", async () => {
    const fx = librarianFixtures(content);
    await fx.analysis("p1", claim("c1", "A treaty bans weather weapons"), "Weather warfare");
    const themes = savedThemes(content);
    const row = (await themes.list({})).rows.find((r) => r.postId === "p1")!;
    // A post that was never analysed at this revision.
    const missing = await themes.forPost({ publicationId: "pub", postId: "never" }, row.sourceVersion);
    expect(missing).toEqual({ state: "not-analysed", themes: [] });

    const trace = await traceArticle({
      post,
      articles: {
        recent: async () => [],
        find: async () => ({ ...post, sourceVersion: row.sourceVersion }),
      },
      themes,
    });
    expect(renderTrace(trace)).toContain("Weather warfare");
  });

  it("escapes hostile proposal text", async () => {
    const fx = librarianFixtures(content);
    await fx.analysis("p1", claim("c1", "x"), "<script>alert(1)</script>");
    const themes = savedThemes(content);
    const row = (await themes.list({})).rows.find((r) => r.postId === "p1")!;
    const trace = await traceArticle({
      post,
      articles: {
        recent: async () => [],
        find: async () => ({ ...post, sourceVersion: row.sourceVersion }),
      },
      themes,
    });
    const html = renderTrace(trace);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("article themes edge cases (#496)", () => {
  const sourceVersion = `sha256:${"b".repeat(64)}`;
  const emptyResult = (postId: string, version: string) => ({
    schemaVersion: 1,
    post: { sourceType: "substack", publicationId: "pub", postId },
    sourceVersion: version,
    artifact: {
      repository: "archive",
      commit: "a".repeat(40),
      path: `substack/pub/${postId}/collected.json`,
      hash: `sha256:${"c".repeat(64)}`,
    },
    proposals: [],
    rejected: [],
    catalogueContext: null,
    extraction: {
      schemaVersion: 1,
      modelVersion: "m",
      promptVersion: "theme-proposals-v2",
      proposedAt: "2026-01-01T00:00:00Z",
    },
  });

  it("treats a saved extraction with no proposals as analysed", async () => {
    await content.write(
      "theme-proposals/pub/p1/empty.json",
      `${JSON.stringify(emptyResult("p1", sourceVersion))}\n`,
    );
    expect(await savedThemes(content).forPost(post, sourceVersion)).toEqual({
      state: "ok",
      themes: [],
    });
  });

  it("reports a partial state when a saved result cannot be read", async () => {
    await content.write(
      "theme-proposals/pub/p1/empty.json",
      `${JSON.stringify(emptyResult("p1", sourceVersion))}\n`,
    );
    await content.write("theme-proposals/pub/p1/broken.json", "{not json");
    const found = await savedThemes(content).forPost(post, sourceVersion);
    expect(found.state).toBe("partial");
    expect(found.themes).toEqual([]);
  });
});
