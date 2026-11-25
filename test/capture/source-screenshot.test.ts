import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  browserlessRenderer,
  captureSourceScreenshot,
  screenshotPath,
  type ScreenshotRenderer,
} from "../../src/capture/source-screenshot.js";

/** A real 1 × 1 PNG, so structural validation is exercised. */
function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(1, 0);
ihdr.writeUInt32BE(1, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const PNG = new Uint8Array(
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
const TRUNCATED = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const post = {
  publicationId: "pub",
  postId: "a-post",
  url: "https://pub.substack.com/p/a-post",
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
    const truncated = await captureSourceScreenshot(post, {
      renderer: renderer(async () => TRUNCATED),
      artifacts,
    });
    expect(truncated.record).toMatchObject({
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

  it("never sends the browser to a host outside the allowlist", async () => {
    let called = false;
    for (const url of [
      "https://127.0.0.1/p/x",
      "https://internal.example/p/x",
      "https://pub.substack.com:8443/p/x",
      "http://pub.substack.com/p/x",
    ]) {
      const out = await captureSourceScreenshot(
        { ...post, url },
        {
          renderer: renderer(async () => {
            called = true;
            return PNG;
          }),
          artifacts,
        },
      );
      expect(out.record).toMatchObject({
        status: "unavailable",
        reason: "not-allowed",
      });
    }
    expect(called).toBe(false);
  });

  it("treats a site error page as unavailable and refuses internal requests in the browser", async () => {
    let body:
      { rejectRequestPattern: string[]; addStyleTag: unknown[] } | undefined;
    const r = browserlessRenderer({
      endpoint: "http://browser:3000",
      fetch: (async (_url: URL, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(PNG, { headers: { "x-response-code": "404" } });
      }) as never,
    });
    const out = await captureSourceScreenshot(post, { renderer: r, artifacts });
    expect(out.record).toMatchObject({
      status: "unavailable",
      reason: "render-failed",
    });
    const refused = body!.rejectRequestPattern.map((p) => new RegExp(p));
    for (const u of [
      "http://pub.substack.com/",
      "https://127.0.0.1/",
      "https://192.168.1.5/x",
      "https://localhost/",
    ])
      expect(
        refused.some((re) => re.test(u)),
        u,
      ).toBe(true);
    expect(
      refused.some((re) => re.test("https://pub.substack.com/p/a-post")),
    ).toBe(false);
    expect(body!.addStyleTag.length).toBeGreaterThan(0);
  });
});
