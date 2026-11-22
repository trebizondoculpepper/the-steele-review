import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  CollectionRecordSchema,
  type CollectionRecord,
} from "../../src/collection/collection-store.js";
import {
  embeddedImageCandidates,
  retainEmbeddedImages,
  retainPreviewImage,
  type ImageFetcherPort,
} from "../../src/collection/preview-retention.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";

// Synthetic images and URLs only (#277).
const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);
const A = "https://cdn.example.org/images/a.png";
const B = "https://cdn.example.org/images/b.png";
const B_MIRROR = "https://mirror.example.org/b-copy.png";
const BROKEN = "https://cdn.example.org/images/broken.png";
const LINKED = "https://cdn.example.org/full/c.jpg";
const COVER = "https://cdn.example.org/cover.png";

const HTML = `
<p>Intro</p>
<img src="${A}" alt="A chart &amp; key">
<p><img src='${A}' alt="Same chart again"></p>
<img src="${B}" alt="Second">
<img src="${B_MIRROR}">
<img src="http://insecure.example.org/x.png" alt="plain http">
<img src="https://substack.com/img/podcast/generic.png">
<img src="${BROKEN}" alt="Broken">
<a href="${LINKED}">full size</a>
<a href="https://example.org/article">a page, not an image</a>
<img src="${COVER}" alt="Cover in body">
`;

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-embedded-"));
  await mkdir(join(dir, "raw"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "raw"), repository: "archive" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const record = (html?: string): CollectionRecord => ({
  item: {
    publicationId: "pub",
    postId: "p1",
    url: "https://pub.example.org/p/p1",
    title: "Synthetic",
  },
  ingestionReason: "live",
  text: "Synthetic text.",
  complete: true,
  supplied: html ? { articleHtml: html } : {},
  previewImage: { url: COVER, source: "cover_image", kind: "uploaded" },
  provenance: {
    sourceUrl: "https://pub.example.org/p/p1",
    acquiredAt: "2026-02-01T00:00:00.000Z",
    method: "article-html",
  },
});

function fetcher(): ImageFetcherPort & { calls: string[] } {
  const calls: string[] = [];
  const bytes: Record<string, Buffer> = {
    [A]: png(1),
    [B]: png(2),
    [B_MIRROR]: png(2), // identical bytes under another URL
    [LINKED]: png(3),
    [COVER]: png(9),
  };
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      if (!bytes[url]) throw new Error("refused");
      return { bytes: bytes[url]!, contentType: "image/png" as const };
    },
  };
}

const read = (a: { repository: string; commit: string; path: string; hash: string }) =>
  artifacts.readBinary({ ...a, sha256: a.hash.slice(7) });

describe("embedded image retention (#277)", () => {
  it("finds HTTPS image sources and image links in document order, skipping the rest", () => {
    expect(embeddedImageCandidates(HTML)).toEqual([
      { url: A, alt: "A chart & key" },
      { url: A, alt: "Same chart again" },
      { url: B, alt: "Second" },
      { url: B_MIRROR },
      { url: BROKEN, alt: "Broken" },
      { url: LINKED },
      { url: COVER, alt: "Cover in body" },
    ]);
  });

  it("retains the thumbnail first, then each distinct image once with all sources and alt text", async () => {
    const f = fetcher();
    const signal = new AbortController().signal;
    const preview = await retainPreviewImage(record(HTML), { fetcher: f, artifacts, signal });
    expect(preview.outcome).toBe("retained");
    const { record: out, report } = await retainEmbeddedImages(preview.record, {
      fetcher: f,
      artifacts,
      signal,
    });
    expect(report).toEqual({ retained: 3, failed: 1, truncated: false });
    // Each URL is fetched at most once; the thumbnail is not fetched again.
    expect(f.calls.filter((u) => u === A)).toHaveLength(1);
    expect(f.calls.filter((u) => u === COVER)).toHaveLength(1);
    const images = CollectionRecordSchema.parse(out).images!;
    expect(images).toMatchObject({ version: "retained-images-v1", failed: 1 });
    const [thumb, a, b, linked] = images.items;
    expect(thumb).toMatchObject({
      thumbnail: true,
      sources: [{ url: COVER, alt: "Cover in body" }],
    });
    expect(a).toMatchObject({
      thumbnail: false,
      sources: [{ url: A, alt: "A chart & key | Same chart again" }],
    });
    // Identical bytes from two URLs are stored once with both sources.
    expect(b!.sources).toEqual([{ url: B, alt: "Second" }, { url: B_MIRROR }]);
    expect(linked!.sources).toEqual([{ url: LINKED }]);
    // Every reference resolves to its exact retained bytes; nothing dangles.
    expect(Buffer.compare(await read(a!.artifact), png(1))).toBe(0);
    expect(Buffer.compare(await read(b!.artifact), png(2))).toBe(0);
    expect(Buffer.compare(await read(thumb!.artifact), png(9))).toBe(0);
    expect(await artifacts.list("substack/pub/p1/images", 20)).toHaveLength(4);
    expect(images.items.some((i) => i.sources.some((s) => s.url === BROKEN))).toBe(false);
  });

  it("leaves a record without article HTML unchanged", async () => {
    const r = record();
    const out = await retainEmbeddedImages(r, {
      fetcher: fetcher(),
      artifacts,
      signal: new AbortController().signal,
    });
    expect(out.record).toBe(r);
    expect(out.report).toEqual({ retained: 0, failed: 0, truncated: false });
  });

  it("stops at its time bound and marks the set truncated, keeping what it saved", async () => {
    let first = true;
    const slow: ImageFetcherPort = {
      fetch: async (url, signal) => {
        if (first) {
          first = false;
          return { bytes: png(1), contentType: "image/png" };
        }
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          void resolve;
        });
        throw new Error(`unreachable ${url}`);
      },
    };
    const { record: out, report } = await retainEmbeddedImages(record(HTML), {
      fetcher: slow,
      artifacts,
      signal: new AbortController().signal,
      deadlineMs: 200,
    });
    expect(report.truncated).toBe(true);
    expect(report.retained).toBe(1);
    expect(out.images).toMatchObject({ truncated: true });
    expect(out.images!.items).toHaveLength(1);
  });
});
