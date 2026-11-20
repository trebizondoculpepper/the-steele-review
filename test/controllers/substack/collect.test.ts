import { describe, expect, it } from "vite-plus/test";
import {
  SubstackContentCollector,
  htmlToPlainText,
  type CollectionResult,
} from "../../../src/controllers/substack/collect.js";
import type { SubstackItem } from "../../../src/content/substack-item.js";

// Synthetic fixtures modelled on the observed public post response.
const PUB = "https://example-pub.substack.com/";
const CDN = "https://substackcdn.com/video_upload/post/1/u1/2/transcription.json?Signature=SECRET";
const item: SubstackItem = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  title: "A post",
};
const segments = [
  { start: 1.5, end: 4, text: " First sentence.", words: [{ word: " First" }] },
  { start: 4.2, end: 7.9, text: " Second sentence." },
];
const transcribed = {
  id: "u1",
  duration: 10,
  transcription: {
    status: "transcribed",
    language: "en",
    cdn_url: CDN,
    media_upload_id: "u1",
  },
};
const basePost = {
  slug: "a-post",
  canonical_url: item.url,
  type: "newsletter",
  audience: "everyone",
  body_html: "<p>Hello <a href='https://x.test'>world</a>.</p><figure><img src='a.png'></figure>",
};

type Routes = Record<string, unknown>;
function collector(routes: Routes) {
  const calls: string[] = [];
  const fetch = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const key = url.hostname === "substackcdn.com" ? "cdn" : url.pathname;
    calls.push(key);
    const route = routes[key];
    if (route === undefined) return new Response("", { status: 404 });
    if (typeof route === "number") return new Response("", { status: route });
    if (typeof route === "string") return new Response(route);
    return new Response(JSON.stringify(route));
  }) as typeof globalThis.fetch;
  const c = new SubstackContentCollector({
    publicationUrl: PUB,
    fetch,
    sleep: async () => {},
    now: () => new Date("2026-02-01T00:00:00Z"),
  });
  return { c, calls };
}

const POST_PATH = "/api/v1/posts/a-post";

describe("htmlToPlainText", () => {
  it("keeps link destinations and drops images and figures", () => {
    expect(htmlToPlainText(basePost.body_html)).toBe("Hello world [https://x.test].");
  });
});

describe("SubstackContentCollector", () => {
  it("returns article text for a newsletter post", async () => {
    const { c } = collector({ [POST_PATH]: basePost });
    const result = await c.collect(item);
    expect(result).toMatchObject({
      kind: "text",
      text: "Hello world [https://x.test].",
      complete: true,
      supplied: { articleHtml: basePost.body_html },
      provenance: {
        method: "article-html",
        sourceUrl: item.url,
        acquiredAt: "2026-02-01T00:00:00.000Z",
      },
    });
  });

  it("prefers the supplied transcript and keeps timestamps", async () => {
    const { c, calls } = collector({
      [POST_PATH]: {
        ...basePost,
        type: "podcast",
        podcast_url: "https://api.substack.com/audio/1.mp3",
        podcastUpload: transcribed,
      },
      cdn: segments,
    });
    const result = (await c.collect(item)) as Extract<CollectionResult, { kind: "text" }>;
    expect(result.kind).toBe("text");
    expect(result.supplied.transcript).toEqual([
      { start: 1.5, end: 4, text: " First sentence." },
      { start: 4.2, end: 7.9, text: " Second sentence." },
    ]);
    expect(result.text).toBe("Hello world [https://x.test].\n\nFirst sentence. Second sentence.");
    expect(JSON.parse(result.supplied.transcriptDocument!)).toEqual(segments);
    expect(result.provenance).toMatchObject({
      method: "supplied-transcript+article-html",
      mediaUploadId: "u1",
      transcriptLanguage: "en",
    });
    expect(calls).toEqual([POST_PATH, "cdn"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("asks for audio transcription when no transcript is supplied", async () => {
    const { c } = collector({
      [POST_PATH]: {
        ...basePost,
        type: "podcast",
        podcast_url: "https://api.substack.com/audio/1.mp3",
        podcast_duration: 99,
        videoUpload: { id: "v1" },
      },
    });
    expect(await c.collect(item)).toMatchObject({
      kind: "transcription-required",
      media: { kind: "audio", url: "https://api.substack.com/audio/1.mp3", durationSeconds: 99 },
      articleText: "Hello world [https://x.test].",
    });
  });

  it("falls back to video when there is no audio", async () => {
    const { c } = collector({
      [POST_PATH]: { ...basePost, type: "video", videoUpload: { id: "v1", duration: 5 } },
    });
    expect(await c.collect(item)).toMatchObject({
      kind: "transcription-required",
      media: { kind: "video", uploadId: "v1", durationSeconds: 5 },
    });
  });

  it("treats an unusable transcript document as missing", async () => {
    const { c } = collector({
      [POST_PATH]: {
        ...basePost,
        podcast_url: "https://api.substack.com/audio/1.mp3",
        podcastUpload: transcribed,
      },
      cdn: { not: "segments" },
    });
    expect((await c.collect(item)).kind).toBe("transcription-required");
  });

  it("marks a media post incomplete when only its description is usable", async () => {
    const { c } = collector({
      [POST_PATH]: {
        ...basePost,
        type: "podcast",
        podcastUpload: {
          ...transcribed,
          transcription: { ...transcribed.transcription, cdn_url: "https://evil.test/t.json" },
        },
      },
    });
    expect(await c.collect(item)).toMatchObject({ kind: "text", complete: false });
  });

  it("ignores transcript links outside the Substack CDN", async () => {
    const { c, calls } = collector({
      [POST_PATH]: {
        ...basePost,
        podcastUpload: {
          ...transcribed,
          transcription: { ...transcribed.transcription, cdn_url: "https://evil.test/t.json" },
        },
      },
    });
    expect((await c.collect(item)).kind).toBe("text");
    expect(calls).toEqual([POST_PATH]);
  });

  it("returns partial text for restricted posts without fetching transcripts", async () => {
    const { c, calls } = collector({
      [POST_PATH]: {
        ...basePost,
        audience: "only_paid",
        body_html: null,
        truncated_body_text: "Preview only",
        podcastUpload: transcribed,
      },
    });
    expect(await c.collect(item)).toEqual({
      kind: "unavailable",
      item,
      reason: "restricted",
      partialText: "Preview only",
    });
    expect(calls).toEqual([POST_PATH]);
  });

  it("distinguishes not found, no content, malformed and transient failures", async () => {
    expect((await collector({}).c.collect(item)).kind === "unavailable").toBe(true);
    expect(await collector({}).c.collect(item)).toMatchObject({ reason: "not-found" });
    expect(
      await collector({ [POST_PATH]: { ...basePost, body_html: "" } }).c.collect(item),
    ).toMatchObject({ kind: "unavailable", reason: "no-content" });
    expect(await collector({ [POST_PATH]: "{oops" }).c.collect(item)).toMatchObject({
      kind: "unavailable",
      reason: "malformed-response",
    });
    expect(
      await collector({ [POST_PATH]: { ...basePost, slug: "other-post" } }).c.collect(item),
    ).toMatchObject({ reason: "malformed-response" });
    const transient = await collector({ [POST_PATH]: 503 }).c.collect(item);
    expect(transient).toMatchObject({ kind: "transient-failure" });
    expect(JSON.stringify(transient)).not.toContain("example-pub.substack.com/api");
  });

  it.each([403, 404, 410])(
    "treats a transcript document returning %i as missing, not the post",
    async (status) => {
      const { c } = collector({
        [POST_PATH]: {
          ...basePost,
          podcast_url: "https://api.substack.com/audio/1.mp3",
          podcastUpload: transcribed,
        },
        cdn: status,
      });
      expect((await c.collect(item)).kind).toBe("transcription-required");
    },
  );

  it("rejects a transcript with no usable text", async () => {
    const { c } = collector({
      [POST_PATH]: {
        ...basePost,
        podcast_url: "https://api.substack.com/audio/1.mp3",
        podcastUpload: transcribed,
      },
      cdn: [{ start: 0, end: 10, text: "  " }],
    });
    expect((await c.collect(item)).kind).toBe("transcription-required");
  });

  it("reports a transient transcript failure rather than requesting transcription", async () => {
    const { c } = collector({
      [POST_PATH]: { ...basePost, podcastUpload: transcribed },
      cdn: 503,
    });
    expect((await c.collect(item)).kind).toBe("transient-failure");
  });
});

// Bounded live validation; runs only when explicitly configured.
const liveUrl = process.env.STEELE_LIVE_PUBLICATION_URL;
const liveId = process.env.STEELE_LIVE_PUBLICATION_ID;
const livePost = process.env.STEELE_LIVE_POST_ID;
describe.skipIf(!liveUrl || !liveId || !livePost)("live collection", () => {
  it("collects text or a media reference for a configured public post", async () => {
    const c = new SubstackContentCollector({ publicationUrl: liveUrl!, maxAttempts: 2 });
    const result = await c.collect(
      {
        publicationId: liveId!,
        postId: livePost!,
        url: new URL(`/p/${livePost}`, liveUrl).href,
        title: "live",
      },
      AbortSignal.timeout(60_000),
    );
    expect(["text", "transcription-required"]).toContain(result.kind);
  }, 90_000);
});

describe("preview image (#277)", () => {
  const PUBLICATION_PATH = "/api/v1/publication";
  const generic = "https://substack.com/img/podcast/generic.png";
  const videoFrame =
    "https://substackcdn.com/video_upload/post/a-post/uuid/transcoded-00001.png";
  const uploaded = "https://substackcdn.com/public/images/uuid_1200x800.png";

  const collectWith = async (post: object, publication?: object) =>
    collector({ [POST_PATH]: { ...basePost, ...post }, ...(publication ? { [PUBLICATION_PATH]: publication } : {}) })
      .c.collect(item);

  it("keeps a post-specific video frame", async () => {
    const result = await collectWith({ type: "video", cover_image: videoFrame });
    expect(result).toMatchObject({
      kind: "text",
      previewImage: { url: videoFrame, source: "cover_image", kind: "video-frame" },
    });
  });

  it("keeps an uploaded image and marks it uploaded", async () => {
    const result = await collectWith({ cover_image: uploaded });
    expect(result).toMatchObject({ previewImage: { url: uploaded, kind: "uploaded" } });
  });

  it("omits a null cover", async () => {
    const result = await collectWith({ cover_image: null });
    expect(result).toMatchObject({ kind: "text" });
    expect((result as { previewImage?: unknown }).previewImage).toBeUndefined();
  });

  it("omits Substack's generic podcast art", async () => {
    const result = await collectWith({ type: "podcast", cover_image: generic });
    expect((result as { previewImage?: unknown }).previewImage).toBeUndefined();
  });

  it("omits the publication logo and cover photo", async () => {
    const logo = await collectWith({ cover_image: uploaded }, { logo_url: uploaded });
    expect((logo as { previewImage?: unknown }).previewImage).toBeUndefined();
    const cover = await collectWith({ cover_image: videoFrame }, { cover_photo_url: videoFrame });
    expect((cover as { previewImage?: unknown }).previewImage).toBeUndefined();
  });

  it("omits an explicit-flagged cover", async () => {
    const result = await collectWith({ cover_image: uploaded, cover_image_is_explicit: true });
    expect((result as { previewImage?: unknown }).previewImage).toBeUndefined();
  });
});

describe("preview image validation (#277)", () => {
  const POST = "/api/v1/posts/a-post";
  it("omits a malformed or non-HTTPS cover instead of failing collection", async () => {
    for (const cover_image of ["not-a-url", "http://example.test/art.png"]) {
      const result = await collector({ [POST]: { ...basePost, cover_image } }).c.collect(item);
      expect(result).toMatchObject({ kind: "text" });
      expect((result as { previewImage?: unknown }).previewImage).toBeUndefined();
    }
  });

  it("keeps the image when the post needs transcription", async () => {
    const cover = "https://substackcdn.com/public/images/uuid_1200x800.png";
    const result = await collector({
      [POST]: {
        ...basePost,
        type: "podcast",
        cover_image: cover,
        podcast_url: "https://api.substack.com/audio/1.mp3",
        podcastUpload: { id: "u9", duration: 30, transcription: { status: "pending" } },
      },
    }).c.collect(item);
    expect(result).toMatchObject({
      kind: "transcription-required",
      previewImage: { url: cover, kind: "uploaded" },
    });
  });
});

describe("publication lookup retry (#277)", () => {
  it("retries the publication lookup after a transient failure", async () => {
    // First publication read fails, the second succeeds with the logo.
    let publications = 0;
    const brand = "https://substackcdn.com/public/images/logo_500x500.png";
    const fetch = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/posts/a-post") {
        return new Response(JSON.stringify({ ...basePost, cover_image: brand }));
      }
      if (url.pathname === "/api/v1/publication") {
        publications++;
        if (publications === 1) return new Response("", { status: 503 });
        return new Response(JSON.stringify({ logo_url: brand }));
      }
      return new Response("", { status: 404 });
    }) as typeof globalThis.fetch;
    const c = new SubstackContentCollector({
      publicationUrl: PUB,
      fetch,
      sleep: async () => {},
      now: () => new Date("2026-02-01T00:00:00Z"),
    });

    await c.collect(item);
    const second = await c.collect(item);
    expect(publications).toBe(2);
    expect((second as { previewImage?: unknown }).previewImage).toBeUndefined();
  });
});
