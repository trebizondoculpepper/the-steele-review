import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  browserlessRenderer,
  captureSourceScreenshot,
  screenshotPath,
  type ScreenshotRenderer,
} from "../../src/capture/source-screenshot.js";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const post = {
  publicationId: "pub",
  postId: "a-post",
  url: "https://pub.example.com/p/a-post",
};
let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "screenshot-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "archive" });
  await artifacts.initialise();
});
afterEach(() => rm(dir, { recursive: true, force: true }));
const renderer = (
  render: ScreenshotRenderer["render"],
): ScreenshotRenderer => ({
  name: "fake",
  render,
});

describe("optional source screenshot (#892)", () => {
  it("saves the PNG content-addressed and one stable record naming it", async () => {
    const out = await captureSourceScreenshot(post, {
      renderer: renderer(async () => PNG),
      artifacts,
    });
    expect(out.record).toMatchObject({
      status: "captured",
      viewport: { width: 800, height: 600 },
    });
    expect(out.ref.path).toBe(screenshotPath(post));
    if (out.record.status !== "captured") throw new Error("expected capture");
    expect(out.record.image.path).toMatch(
      /^substack\/pub\/a-post\/images\/[0-9a-f]{64}\.png$/,
    );
    // A refresh with identical pixels makes no new commit.
    const again = await captureSourceScreenshot(post, {
      renderer: renderer(async () => PNG),
      artifacts,
    });
    expect(again.ref).toEqual(out.ref);
  });

  it("records an unavailable screenshot instead of failing ingestion", async () => {
    const failed = await captureSourceScreenshot(post, {
      renderer: renderer(async () => {
        throw new Error("browser down");
      }),
      artifacts,
    });
    expect(failed.record).toMatchObject({
      status: "unavailable",
      reason: "render-failed",
    });
    const html = await captureSourceScreenshot(post, {
      renderer: renderer(async () => new TextEncoder().encode("<html>")),
      artifacts,
    });
    expect(html.record).toMatchObject({
      status: "unavailable",
      reason: "not-png",
    });
    // The record is revised in place; Git keeps the history.
    expect(html.ref.path).toBe(failed.ref.path);
  });

  it("asks the browser container for an 800 × 600 PNG of an https post only", async () => {
    let body: unknown;
    const r = browserlessRenderer({
      endpoint: "http://browser:3000",
      fetch: (async (_url: URL, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(PNG);
      }) as never,
    });
    expect(await r.render(post.url)).toEqual(PNG);
    expect(body).toMatchObject({
      url: post.url,
      viewport: { width: 800, height: 600 },
    });
    await expect(r.render("http://pub.example.com/p/a-post")).rejects.toThrow();
  });
});
