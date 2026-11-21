import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { archivedSource } from "../../src/dashboard/adapters.js";
import { renderTrace } from "../../src/dashboard/article-views.js";
import type { ArticleTrace } from "../../src/dashboard/articles.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";

let dir: string;
let archive: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-source-"));
  archive = new GitArtifactStore({ repoPath: dir, repository: "archive" });
  await archive.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const post = { publicationId: "pub", postId: "p1" };
const record = (text: string, over: Record<string, unknown> = {}) => ({
  item: {
    publicationId: "pub",
    postId: "p1",
    url: "https://example.test/p/p1",
    title: "A captured post",
  },
  ingestionReason: "backfill",
  text,
  complete: true,
  supplied: {},
  provenance: {
    sourceUrl: "https://example.test/p/p1",
    acquiredAt: "2026-01-01T00:00:00Z",
    method: "supplied-transcript",
  },
  ...over,
});

const trace = (source: ArticleTrace["source"]): ArticleTrace => ({
  post,
  correlationId: "cid",
  summary: "completed",
  stages: [],
  research: [],
  receipts: [],
  receiptsTruncated: false,
  ...(source ? { source } : {}),
});

describe("archivedSource (#446)", () => {
  it("reads the retained capture with provenance and an exact revision", async () => {
    await archive.write(
      "substack/pub/p1/collected.json",
      `${JSON.stringify(record("Hello <script>alert(1)</script> body"))}\n`,
    );
    const source = await archivedSource(archive).read(post);
    expect(source).toMatchObject({
      state: "recorded",
      title: "A captured post",
      url: "https://example.test/p/p1",
      method: "supplied-transcript",
      complete: true,
      matchesRevision: null,
    });
    if (source.state !== "recorded") throw new Error("expected recorded");
    expect(source.revision).toMatch(/^[0-9a-f]{12}:substack\/pub\/p1\/collected\.json$/);
    expect(source.text).toContain("<script>");
    expect(source.truncated).toBe(false);
  });

  it("flags a revision mismatch and bounds the displayed text", async () => {
    await archive.write(
      "substack/pub/p1/collected.json",
      `${JSON.stringify(record("x".repeat(50)))}\n`,
    );
    const source = await archivedSource(archive, { maxChars: 10 }).read(post, "sha256:other");
    expect(source).toMatchObject({
      state: "recorded",
      truncated: true,
      matchesRevision: false,
    });
    if (source.state !== "recorded") throw new Error("expected recorded");
    expect(source.text).toHaveLength(10);
    expect(source.sourceVersion).not.toBe("sha256:other");
  });

  it("reports a matching revision when the selected version is the retained one", async () => {
    const text = "the retained body";
    await archive.write("substack/pub/p1/collected.json", `${JSON.stringify(record(text))}\n`);
    const version = sourceVersionFor(text);
    expect(await archivedSource(archive).read(post, version)).toMatchObject({
      state: "recorded",
      matchesRevision: true,
    });
  });

  it("reports missing and unreadable captures distinctly", async () => {
    expect(await archivedSource(archive).read(post)).toEqual({ state: "missing" });
    await archive.write("substack/pub/p2/collected.json", "{not json");
    expect(await archivedSource(archive).read({ publicationId: "pub", postId: "p2" })).toEqual({
      state: "unreadable",
    });
  });
});

describe("renderTrace retained source (#446)", () => {
  it("escapes hostile markup and shows provenance", () => {
    const html = renderTrace(
      trace({
        state: "recorded",
        title: "T <b>title</b>",
        url: "https://example.test/p/p1",
        method: "supplied-transcript",
        complete: true,
        sourceVersion: `sha256:${"a".repeat(64)}`,
        revision: "abcdef123456:substack/pub/p1/collected.json",
        text: "<script>alert(1)</script>",
        truncated: false,
        matchesRevision: true,
      }),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;title&lt;/b&gt;");
    expect(html).toContain('href="https://example.test/p/p1"');
    expect(html).toContain("supplied-transcript");
  });

  it("warns on a revision mismatch and labels a truncated display", () => {
    const html = renderTrace(
      trace({
        state: "recorded",
        method: "machine-transcript",
        complete: false,
        sourceVersion: `sha256:${"a".repeat(64)}`,
        revision: "abcdef123456:substack/pub/p1/collected.json",
        text: "partial",
        truncated: true,
        matchesRevision: false,
      }),
    );
    expect(html).toContain("does not match the revision");
    expect(html).toContain("Display truncated");
    expect(html).toContain("INCOMPLETE");
  });

  it("labels missing and unreadable captures", () => {
    expect(renderTrace(trace({ state: "missing" }))).toContain("Captured source: missing");
    expect(renderTrace(trace({ state: "unreadable" }))).toContain("Captured source: unreadable");
  });
});
