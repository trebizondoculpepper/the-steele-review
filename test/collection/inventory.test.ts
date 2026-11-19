import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { collectionArtifactPath } from "../../src/collection/collection-store.js";
import { listCapturedPosts } from "../../src/collection/inventory.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";

let dir: string;
let archive: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-inventory-SENTINELPATH-"));
  archive = new GitArtifactStore({ repoPath: dir, repository: "archive" });
  await archive.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function capture(postId: string, complete = true, publicationId = "pub") {
  const item = {
    publicationId,
    postId,
    url: `https://${publicationId}.example.com/p/${postId}`,
    title: `Title ${postId}`,
    publishedAt: "2026-01-02T03:04:05.000Z",
  };
  await archive.write(
    collectionArtifactPath(item),
    JSON.stringify({
      item,
      ingestionReason: "backfill",
      text: "Some text.",
      complete,
      supplied: {},
      provenance: {
        sourceUrl: item.url,
        acquiredAt: "2026-01-03T00:00:00.000Z",
        method: "article-html",
      },
    }),
  );
}

describe("listCapturedPosts", () => {
  it("lists a bounded, stable page and paginates", async () => {
    for (const id of ["c-post", "a-post", "b-post"]) await capture(id);
    const first = await listCapturedPosts(archive, { limit: 2 });
    expect(first.posts.map((p) => p.postId)).toEqual(["a-post", "b-post"]);
    expect(first).toMatchObject({ truncated: true, next: "pub/b-post" });
    expect(first.posts[0]).toMatchObject({
      title: "Title a-post",
      url: "https://pub.example.com/p/a-post",
      publishedAt: "2026-01-02T03:04:05.000Z",
      complete: true,
      method: "article-html",
    });
    const second = await listCapturedPosts(archive, { limit: 2, after: first.next });
    expect(second.posts.map((p) => p.postId)).toEqual(["c-post"]);
    expect(second.truncated).toBe(false);
  });

  it("reports truncation at the scan budget and pages beyond it via the controller cursor", async () => {
    for (const id of ["a", "b", "c", "d"]) await capture(id);
    const first = await listCapturedPosts(archive, { scanLimit: 2, limit: 50 });
    expect(first.posts.map((p) => p.postId)).toEqual(["a", "b"]);
    expect(first).toMatchObject({ truncated: true, next: "pub/b" });
    const second = await listCapturedPosts(archive, { scanLimit: 2, limit: 50, after: first.next });
    expect(second.posts.map((p) => p.postId)).toEqual(["c", "d"]);
    const third = await listCapturedPosts(archive, { scanLimit: 2, limit: 50, after: second.next });
    expect(third.posts).toEqual([]);
    expect(third.truncated).toBe(false);
  });

  it("reports incomplete posts, filters them on request and filters by publication", async () => {
    await capture("done");
    await capture("partial", false);
    await capture("elsewhere", true, "other");
    const all = await listCapturedPosts(archive, { publicationId: "pub" });
    expect(all.posts.map((p) => [p.postId, p.complete])).toEqual([
      ["done", true],
      ["partial", false],
    ]);
    const complete = await listCapturedPosts(archive, { publicationId: "pub", completeOnly: true });
    expect(complete.posts.map((p) => p.postId)).toEqual(["done"]);
  });

  it("lists malformed records by identity without failing the inventory", async () => {
    await capture("good");
    await archive.write("substack/pub/broken/collected.json", "{not json");
    const out = await listCapturedPosts(archive);
    expect(out.posts.map((p) => p.postId)).toEqual(["good"]);
    expect(out.malformed).toEqual([{ publicationId: "pub", postId: "broken" }]);
  });

  it("treats an unavailable archive as an error, never as empty, and creates nothing", async () => {
    const missing = join(dir, "does-not-exist");
    const store = new GitArtifactStore({ repoPath: missing, repository: "archive" });
    await expect(listCapturedPosts(store)).rejects.toThrow();
    const { existsSync } = await import("node:fs");
    expect(existsSync(missing)).toBe(false);
  });
});

describe("list-posts command", () => {
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli/list-posts.ts", ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      encoding: "utf8",
      timeout: 30_000,
    });

  it("prints JSON without filesystem paths and fails clearly when unavailable", async () => {
    await capture("a-post");
    const ok = run(["--json"], { STEELE_ARCHIVE_PATH: dir, STEELE_ARCHIVE_REPOSITORY: "archive" });
    expect(ok.status).toBe(0);
    const parsed = JSON.parse(ok.stdout);
    expect(parsed.posts[0].postId).toBe("a-post");
    expect(ok.stdout + ok.stderr).not.toContain("SENTINELPATH");

    const bad = run([], {
      STEELE_ARCHIVE_PATH: join(dir, "nope"),
      STEELE_ARCHIVE_REPOSITORY: "archive",
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("archive unavailable");
    expect(bad.stdout + bad.stderr).not.toContain("SENTINELPATH");
    expect(run(["--limit", "0"], {}).status).toBe(2);
  }, 60_000);
});
