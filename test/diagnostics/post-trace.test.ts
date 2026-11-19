import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import { proposeThemes } from "../../src/analysis/theme-proposals.js";
import { collectionArtifactPath } from "../../src/collection/collection-store.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { OperationInspection } from "../../src/controllers/operation-store.js";
import { renderPostTrace, traceIncomplete, tracePost } from "../../src/diagnostics/post-trace.js";

const SENTINEL = "SENTINEL-secret-token-9f2a";
const TEXT = "The towers emit radiation. This is the current text.";
const post = { publicationId: "pub", postId: "p" };

let dir: string;
let archive: GitArtifactStore;
let content: GitArtifactStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-trace-"));
  await mkdir(join(dir, "a"));
  await mkdir(join(dir, "c"));
  archive = new GitArtifactStore({ repoPath: join(dir, "a"), repository: "archive" });
  content = new GitArtifactStore({ repoPath: join(dir, "c"), repository: "content" });
  await archive.initialise();
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function capture(text = TEXT) {
  return archive.write(
    collectionArtifactPath(post),
    JSON.stringify({
      item: { ...post, url: "https://pub.example.com/p/p", title: "T" },
      ingestionReason: "backfill",
      text,
      complete: true,
      supplied: {},
      provenance: {
        sourceUrl: "https://pub.example.com/p/p",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        method: "article-html",
      },
    }),
  );
}

const op = (
  status: OperationInspection["status"],
  extra: Partial<OperationInspection> = {},
): OperationInspection => ({
  key: "k",
  status,
  exhausted: status === "failed",
  attempts: 1,
  maxAttempts: 5,
  pendingEvents: { pending: 0, sent: 1 },
  ...extra,
});

const model = (r: string): ExtractionModelProvider => ({
  modelVersion: "fake/m",
  complete: async () => r,
});

describe("tracePost", () => {
  it("shows a captured, indexed post whose later stages have not run", async () => {
    await capture();
    const trace = await tracePost({
      post,
      state: {
        readOperation: async (key) => (key.startsWith("collect:") ? op("completed") : null),
      },
      archive,
      content,
      search: { fulltextSourceVersion: async () => sourceVersionFor(TEXT) },
    });
    expect(trace.capture.operation).toMatchObject({ state: "recorded", status: "completed" });
    expect(trace.capture.archive).toMatchObject({
      state: "recorded",
      complete: true,
      sourceVersion: sourceVersionFor(TEXT),
    });
    expect(trace.index).toEqual({
      state: "recorded",
      sourceVersion: sourceVersionFor(TEXT),
      current: true,
    });
    expect(trace.themes).toEqual({ state: "not-recorded" });
    expect(trace.claims).toEqual({ state: "not-recorded" });
    expect(trace.research).toEqual({ state: "not-traceable" });
    expect(traceIncomplete(trace)).toBe(false);
    expect(renderPostTrace(trace)).toContain("Theme results: not-recorded");
  });

  it("labels results for an older source version as stale, never current", async () => {
    const oldText = "The towers emit radiation.";
    await proposeThemes({
      provider: model('{"themes":[{"title":"5G"}]}'),
      artifacts: content,
      post,
      source: {
        text: oldText,
        sourceVersion: sourceVersionFor(oldText),
        artifact: {
          repository: "archive",
          commit: "a".repeat(40),
          path: "x",
          hash: `sha256:${"b".repeat(64)}`,
        },
      },
    });
    await capture(TEXT);
    const trace = await tracePost({
      post,
      archive,
      content,
      search: { fulltextSourceVersion: async () => sourceVersionFor(oldText) },
    });
    expect(trace.themes.state === "recorded" && trace.themes.results[0].stale).toBe(true);
    expect(trace.index).toMatchObject({ current: false });
    expect(renderPostTrace(trace)).toContain("STALE");
  });

  it("reports unavailable and failed sources distinctly and never leaks error text", async () => {
    await capture();
    const trace = await tracePost({
      post,
      state: {
        readOperation: async () => {
          throw new Error(`connection to ${SENTINEL} refused`);
        },
      },
      archive,
      search: {
        fulltextSourceVersion: async () => {
          throw new Error(SENTINEL);
        },
      },
    });
    expect(trace.capture.operation).toEqual({ state: "unavailable" });
    expect(trace.index).toEqual({ state: "unavailable" });
    expect(trace.themes).toEqual({ state: "not-configured" });
    expect(traceIncomplete(trace)).toBe(true);
    const out = JSON.stringify(trace) + renderPostTrace(trace);
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain(dir);

    const failed = await tracePost({
      post,
      state: {
        readOperation: async () => op("failed", { errorCode: "transcription-unavailable" }),
      },
    });
    expect(failed.capture.operation).toMatchObject({
      state: "recorded",
      status: "failed",
      errorCode: "transcription-unavailable",
    });
  });

  it("changes no stored state while inspecting", async () => {
    await capture();
    const before = [
      await archive.list("substack", 100),
      await content.list("theme-proposals", 100),
    ];
    await tracePost({ post, archive, content });
    expect([
      await archive.list("substack", 100),
      await content.list("theme-proposals", 100),
    ]).toEqual(before);
  });

  it("treats a post with no records anywhere as not found", async () => {
    const trace = await tracePost({
      post,
      state: { readOperation: async () => null },
      archive,
      content,
    });
    expect(trace.capture.archive).toEqual({ state: "not-recorded" });
    expect(traceIncomplete(trace)).toBe(true);
  });
  it("bounds a stalled state read and reports it unavailable", async () => {
    const trace = await tracePost({ post, state: { readOperation: () => new Promise(() => {}) } });
    expect(trace.capture.operation).toEqual({ state: "unavailable" });
  }, 20_000);

  it("reports a broken archive as unavailable, not empty", async () => {
    const broken = new GitArtifactStore({
      repoPath: join(dir, "not-a-repo"),
      repository: "archive",
    });
    await mkdir(join(dir, "not-a-repo"));
    const trace = await tracePost({ post, archive: broken });
    expect(trace.capture.archive).toEqual({ state: "unavailable" });
  });

  it("marks freshness unknown when no current capture is readable, and counts content-only finds", async () => {
    await proposeThemes({
      provider: model('{"themes":[{"title":"5G"}]}'),
      artifacts: content,
      post,
      source: {
        text: TEXT,
        sourceVersion: sourceVersionFor(TEXT),
        artifact: {
          repository: "archive",
          commit: "a".repeat(40),
          path: "x",
          hash: `sha256:${"b".repeat(64)}`,
        },
      },
    });
    const trace = await tracePost({
      post,
      content,
      search: { fulltextSourceVersion: async () => sourceVersionFor(TEXT) },
    });
    expect(trace.themes.state === "recorded" && trace.themes.results[0].stale).toBeNull();
    expect(trace.index).toMatchObject({ current: null });
    expect(renderPostTrace(trace)).toContain("freshness unknown");
    expect(traceIncomplete(trace)).toBe(false);
  });
  it("bounds stalled archive and content reads", async () => {
    const stalled = {
      list: () => new Promise<string[]>(() => {}),
      lookup: () => new Promise<undefined>(() => {}),
      read: () => new Promise<string>(() => {}),
    };
    const trace = await tracePost({ post, archive: stalled, content: stalled });
    expect(trace.capture.archive).toEqual({ state: "unavailable" });
    expect(trace.themes).toEqual({ state: "unavailable" });
    expect(trace.claims).toEqual({ state: "unavailable" });
  }, 30_000);
});
