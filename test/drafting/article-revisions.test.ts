import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore, isRevisablePath } from "../../src/controllers/artifact-store.js";
import { articlePaths } from "../../src/drafting/article-identity.js";
import { commitArticleRevision } from "../../src/drafting/article-revisions.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-article-rev-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const article = { publicationId: "example-pub", postId: "a-synthetic-post" };
const paths = articlePaths(article);
let n = 0;
/** A synthetic write-once generation, as draftFromPackage saves one. */
async function generation(body: string) {
  const key = (++n).toString(16).padStart(32, "0");
  const draft = await content.write(`articles/example-pub/a-synthetic-post/${key}.md`, body);
  const metadata = await content.write(
    `articles/example-pub/a-synthetic-post/${key}.json`,
    JSON.stringify({ fields: { title: `Title ${n}` } }),
  );
  return { draft, metadata };
}

describe("in-place article revisions (#579)", () => {
  it("commits an initial draft and two revisions to the same paths, keeping old bytes", async () => {
    const g1 = await generation("# Initial\n");
    const v1 = await commitArticleRevision({ content, article, generation: g1, base: "current" });
    if (v1.status === "conflict") throw new Error("conflict");
    const g2 = await generation("# Revision one\n");
    const v2 = await commitArticleRevision({
      content,
      article,
      generation: g2,
      base: { body: v1.body.sha256, metadata: v1.metadata.sha256 },
    });
    if (v2.status === "conflict") throw new Error("conflict");
    const g3 = await generation("# Revision two\n");
    const v3 = await commitArticleRevision({
      content,
      article,
      generation: g3,
      base: { body: v2.body.sha256, metadata: v2.metadata.sha256 },
    });
    if (v3.status === "conflict") throw new Error("conflict");

    expect(new Set([v1.body.path, v2.body.path, v3.body.path])).toEqual(new Set([paths.body]));
    expect(new Set([v1.metadata.path, v3.metadata.path])).toEqual(new Set([paths.metadata]));
    expect(new Set([v1.body.commit, v2.body.commit, v3.body.commit]).size).toBe(3);
    // Earlier versions stay readable at their exact commits.
    expect((await content.lookupAt(v1.body.commit, paths.body))?.content).toBe("# Initial\n");
    expect((await content.lookupAt(v1.metadata.commit, paths.metadata))?.content).toContain(
      "Title 1",
    );
    expect(await content.read((await content.lookup(paths.body))!)).toBe("# Revision two\n");
  });

  it("reuses a completed generation's exact result and never rolls back newer content", async () => {
    const g1 = await generation("# Initial\n");
    const v1 = await commitArticleRevision({ content, article, generation: g1, base: "current" });
    if (v1.status === "conflict") throw new Error("conflict");
    const g2 = await generation("# Newer\n");
    await commitArticleRevision({
      content,
      article,
      generation: g2,
      base: { body: v1.body.sha256, metadata: v1.metadata.sha256 },
    });
    // A redelivered retry of the first generation.
    const retry = await commitArticleRevision({
      content,
      article,
      generation: g1,
      base: "current",
    });
    expect(retry).toMatchObject({ status: "reused", body: { commit: v1.body.commit } });
    expect(await content.read((await content.lookup(paths.body))!)).toBe("# Newer\n");
  });

  it("refuses a competing update instead of overwriting it", async () => {
    const g1 = await generation("# Initial\n");
    const v1 = await commitArticleRevision({ content, article, generation: g1, base: "current" });
    if (v1.status === "conflict") throw new Error("conflict");
    const base = { body: v1.body.sha256, metadata: v1.metadata.sha256 };
    const a = await generation("# Writer A\n");
    const b = await generation("# Writer B\n");
    expect((await commitArticleRevision({ content, article, generation: a, base })).status).toBe(
      "committed",
    );
    // B derived from the same base, but A moved the article on.
    expect(await commitArticleRevision({ content, article, generation: b, base })).toEqual({
      status: "conflict",
    });
    expect(await content.read((await content.lookup(paths.body))!)).toBe("# Writer A\n");
  });

  it("reconciles a crash after the canonical write but before the record", async () => {
    const g1 = await generation("# Initial\n");
    // Simulate a pass that wrote the body, then crashed.
    await content.revise(paths.body, "# Initial\n", null);
    const out = await commitArticleRevision({
      content,
      article,
      generation: g1,
      base: { body: null, metadata: null },
    });
    expect(out.status).toBe("committed");
    const again = await commitArticleRevision({
      content,
      article,
      generation: g1,
      base: "current",
    });
    expect(again.status).toBe("reused");
  });

  it("makes only the canonical documents revisable", () => {
    expect(isRevisablePath(paths.body)).toBe(true);
    expect(isRevisablePath(paths.metadata)).toBe(true);
    expect(isRevisablePath(`articles/example-pub/a-synthetic-post/${"0".repeat(32)}.md`)).toBe(
      false,
    );
    expect(isRevisablePath(`${paths.dir}/commits/${"0".repeat(32)}.json`)).toBe(false);
  });
});
