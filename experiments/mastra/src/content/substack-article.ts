import { createHash } from "node:crypto";

import { boundedText, CaptureError, htmlToPlainText, isoOrNull, PostSchema, sanitisePost, Segments, SUBSTACK_CDN_HOST } from "../capture/substack.js";
import { normaliseText } from "../capture/bundle.js";
import type { ChatModel } from "../common/model/openrouter.js";
import { canonicalPostUrl } from "../feed/rss.js";
import type { FeedRecord } from "../feed/substack-poller.js";
import type { SubstackFeed } from "../feed/substack-sources.js";
import { checkTranscript, labelMismatch, sha256, type TranscriptCheck } from "./intelligibility.js";

/**
 * Fetch one Substack post named by a committed feed record (#953) and build
 * its raw-content record and assets.
 *
 * - The article HTML's text is kept as the article (written posts) or as the
 *   description (audio and video), never confused with a transcript.
 * - A transcript Substack supplies is fetched once from its signed CDN link,
 *   which is never stored; the original segments are kept for inspection.
 * - The transcript's usability is judged on its text by a small model call
 *   (intelligibility.ts), not on its language label. Garbled, non-English or
 *   missing transcripts are kept and recorded as a skip for analysis.
 * - The cover image (thumbnail) and images in the article body are downloaded
 *   from Substack's own hosts only, size- and type-bounded, and stored by
 *   content hash. No audio or video is downloaded and nothing is transcribed.
 * - The observed bylines are preserved. A single personal byline is the
 *   author; with none (or only the publication's account byline) the source's
 *   configured author is used; several bylines leave the author unknown.
 *   The basis is always recorded.
 */

export const RECORD_SCHEMA = "raw-content-article-v1";
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 10_000_000;
const IMAGE_TYPES = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

/** Hosts images and thumbnails may come from. */
export function allowedAssetHost(host: string): boolean {
  return (
    host === SUBSTACK_CDN_HOST ||
    host.endsWith(`.${SUBSTACK_CDN_HOST}`) ||
    host === "substack-post-media.s3.amazonaws.com" ||
    host === "substack-video.s3.amazonaws.com" ||
    host === "substack.com"
  );
}

export interface AssetRef {
  /** Path relative to the record's folder. */
  file: string;
  contentType: string;
  bytes: number;
  sha256: string;
  /** Where it came from, without query strings (which can carry signatures). */
  source: string;
}

export interface ArticleRecord {
  schema: typeof RECORD_SCHEMA;
  platform: "substack";
  sourceId: string;
  itemId: string;
  postId: string;
  /** The item's URL exactly as the feed gave it, and its canonical form. */
  url: string;
  canonicalUrl: string;
  title: string;
  subtitle: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  medium: "audio" | "video" | "written" | "unknown";
  /** What the post supplies: an article, or a recording with a description and perhaps a transcript. */
  representation: "article" | "recording";
  feed: { path: string; commit: string };
  /** The article HTML as text: the article itself, or a recording's description. */
  text: { role: "article" | "description"; content: string };
  transcript: {
    /** `fetch-failed`: a transcript exists but could not be downloaded (retried later); `missing`: none supplied. */
    status: "usable" | "unusable" | "missing" | "fetch-failed" | "check-failed";
    languageLabel: string | null;
    content: string | null;
    /** Original supplied segments, kept for inspection even when unusable. */
    original: string | null;
    check: Omit<TranscriptCheck, "languageLabel"> | null;
  };
  /** What downstream analysis should read, or why it should skip this item. */
  analysis: { use: "article" | "transcript" | "skip"; reason?: string };
  attribution: {
    author: string | null;
    authorId: string | null;
    basis: "post-byline" | "source-configured" | "unknown";
    observedBylines: string[];
  };
  thumbnail: AssetRef | null;
  images: AssetRef[];
  original: { post: string };
  warnings: string[];
}

export interface FetchedArticle {
  record: ArticleRecord;
  /** Files to write beside article.json, by relative path. */
  assets: Array<{ file: string; content: Buffer | string }>;
}

export interface FetchOptions {
  feed: SubstackFeed;
  feedRecord: FeedRecord;
  feedRef: { path: string; commit: string };
  model: ChatModel;
  modelId?: string;
  /** A previous record for this item, so an unchanged transcript is not checked (or paid for) again. */
  previous?: ArticleRecord | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const stripQuery = (url: URL) => `${url.origin}${url.pathname}`;

async function downloadAsset(rawUrl: string, options: FetchOptions, warnings: string[]): Promise<{ content: Buffer; ref: Omit<AssetRef, "file"> } | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    warnings.push("asset-url-invalid");
    return null;
  }
  if (url.protocol !== "https:" || !allowedAssetHost(url.hostname)) {
    warnings.push("asset-host-not-allowed");
    return null;
  }
  try {
    const res = await (options.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      warnings.push(`asset-http-${res.status}`);
      return null;
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) {
      await res.body?.cancel().catch(() => undefined);
      warnings.push("asset-not-an-image");
      return null;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => undefined);
          warnings.push("asset-too-large");
          return null;
        }
        chunks.push(value);
      }
    const content = Buffer.concat(chunks);
    return { content, ref: { contentType: type, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), source: stripQuery(url) } };
  } catch {
    warnings.push("asset-unavailable");
    return null;
  }
}

function bodyImageUrls(html: string): string[] {
  const urls = new Set<string>();
  // The src attribute in any valid form: double-quoted, single-quoted or unquoted.
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const m = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag[0]);
    const src = m?.[1] ?? m?.[2] ?? m?.[3];
    if (src) urls.add(src.replaceAll("&amp;", "&"));
  }
  return [...urls].slice(0, MAX_IMAGES);
}

function resolveAttribution(observed: string[], feed: SubstackFeed): ArticleRecord["attribution"] {
  const accountBylines = new Set((feed.sourceAccountBylines ?? []).map((b) => b.normalize("NFKC").trim().toLowerCase()));
  const personal = observed.filter((b) => !accountBylines.has(b.normalize("NFKC").trim().toLowerCase()));
  if (personal.length === 1) return { author: personal[0]!, authorId: null, basis: "post-byline", observedBylines: observed };
  if (personal.length === 0 && feed.defaultAuthor)
    return { author: feed.defaultAuthor.name, authorId: feed.defaultAuthor.id ?? null, basis: "source-configured", observedBylines: observed };
  return { author: null, authorId: null, basis: "unknown", observedBylines: observed };
}

export async function fetchArticle(options: FetchOptions): Promise<FetchedArticle> {
  const { feed, feedRecord } = options;
  const canonical = canonicalPostUrl(feedRecord.canonicalUrl, feed.publicationHost);
  const slug = canonical.pathname.slice(3);
  const cfg = { publicationHost: feed.publicationHost, fetch: options.fetch, timeoutMs: options.timeoutMs };
  let res;
  try {
    res = await boundedText(new URL(`/api/v1/posts/${encodeURIComponent(slug)}`, canonical), cfg);
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError("post-unavailable", "post endpoint unreachable");
  }
  if (res.status === 404) throw new CaptureError("post-not-found", "no such post");
  if (res.status !== 200) throw new CaptureError("post-unavailable", `post endpoint returned ${res.status}`);
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(res.body);
  } catch {
    throw new CaptureError("invalid-post", "post response is not JSON");
  }
  const parsed = PostSchema.safeParse(rawJson);
  if (!parsed.success || parsed.data.slug.toLowerCase() !== slug) throw new CaptureError("invalid-post", "unexpected post shape");
  const post = parsed.data;
  if ((post.audience ?? "everyone") !== "everyone") throw new CaptureError("restricted", "post is not public");

  const warnings: string[] = [];
  const medium: ArticleRecord["medium"] =
    post.videoUpload?.id || post.type === "video"
      ? "video"
      : post.podcastUpload?.id || post.type === "podcast" || post.type === "audio" || post.podcast_url
        ? "audio"
        : (post.type === "newsletter" || post.type === "text") && !post.podcast_url
          ? "written"
          : "unknown";
  const recording = medium === "audio" || medium === "video";
  const articleText = post.body_html?.trim() ? normaliseText(htmlToPlainText(post.body_html)) : "";

  // Supplied transcript: fetched once from its signed link, which is never kept.
  const upload = [post.podcastUpload, post.videoUpload].find((u) => u?.transcription?.status === "transcribed" && u.transcription.cdn_url);
  const languageLabel = upload?.transcription?.language ?? null;
  let transcriptText: string | null = null;
  let transcriptOriginal: string | null = null;
  // A supplied transcript that could not be downloaded is a technical failure, not absence.
  let transcriptFetchFailed = false;
  if (upload?.transcription?.cdn_url) {
    let cdn: URL | undefined;
    try {
      cdn = new URL(upload.transcription.cdn_url);
    } catch {
      cdn = undefined;
    }
    if (cdn && cdn.protocol === "https:" && cdn.hostname === SUBSTACK_CDN_HOST) {
      try {
        const t = await boundedText(cdn, cfg);
        if (t.status === 200) {
          transcriptOriginal = t.body;
          const segs = Segments.safeParse(JSON.parse(t.body));
          transcriptText = segs.success ? normaliseText(segs.data.map((s) => s.text.trim()).join("\n")) : null;
          if (!segs.success) {
            // A response that is not a segment list is a technical failure (retried), not absence.
            warnings.push("transcript-not-segments");
            transcriptFetchFailed = true;
          }
        } else {
          warnings.push(`transcript-http-${t.status}`);
          transcriptFetchFailed = true;
        }
      } catch {
        warnings.push("transcript-unavailable");
        transcriptFetchFailed = true;
      }
    } else warnings.push("transcript-host-not-allowed");
  }

  let transcript: ArticleRecord["transcript"];
  if (!transcriptText) {
    transcript = {
      status: transcriptFetchFailed ? "fetch-failed" : "missing",
      languageLabel,
      content: null,
      original: transcriptOriginal ? "transcript.raw" : null,
      check: null,
    };
  } else {
    const previous = options.previous?.transcript.check;
    const reusable = previous && previous.textSha256 === sha256(transcriptText) && previous.status !== "check-failed";
    const check: TranscriptCheck = reusable
      ? { ...previous, languageLabel, labelMismatch: previous.verdict ? labelMismatch(previous.verdict, languageLabel) : false }
      : await checkTranscript(transcriptText, languageLabel, options.model, options.modelId);
    const { languageLabel: _label, ...stored } = check;
    transcript = { status: check.status, languageLabel, content: transcriptText, original: "transcript.raw", check: stored };
    if (check.labelMismatch) warnings.push("transcript-language-label-mismatch");
  }

  let analysis: ArticleRecord["analysis"];
  if (!recording) analysis = articleText ? { use: "article" } : { use: "skip", reason: "no-article-text" };
  else if (transcript.status === "usable") analysis = { use: "transcript" };
  else
    analysis = {
      use: "skip",
      reason:
        transcript.status === "missing"
          ? "transcript-missing"
          : transcript.status === "fetch-failed"
            ? "transcript-fetch-failed"
            : transcript.status === "check-failed"
            ? "transcript-check-failed"
            : transcript.check?.verdict === "not-english"
              ? "transcript-not-english"
              : "transcript-garbled",
    };

  // Images: the cover as the thumbnail, then images in the article body, by content hash.
  const assets: FetchedArticle["assets"] = [];
  let thumbnail: AssetRef | null = null;
  if (post.cover_image) {
    const got = await downloadAsset(post.cover_image, options, warnings);
    if (got) {
      const file = `thumbnail.${IMAGE_TYPES.get(got.ref.contentType)}`;
      thumbnail = { file, ...got.ref };
      assets.push({ file, content: got.content });
    }
  }
  const images: AssetRef[] = [];
  for (const src of bodyImageUrls(post.body_html ?? "")) {
    const got = await downloadAsset(src, options, warnings);
    if (!got) continue;
    const file = `images/${got.ref.sha256.slice(0, 16)}.${IMAGE_TYPES.get(got.ref.contentType)}`;
    if (images.some((i) => i.file === file)) continue;
    images.push({ file, ...got.ref });
    assets.push({ file, content: got.content });
  }

  const observed = (post.publishedBylines ?? []).map((b) => b.name?.trim()).filter((n): n is string => Boolean(n));
  const record: ArticleRecord = {
    schema: RECORD_SCHEMA,
    platform: "substack",
    sourceId: feed.sourceId,
    itemId: feedRecord.itemId,
    postId: post.id,
    url: feedRecord.url,
    canonicalUrl: canonical.href,
    title: (post.title ?? feedRecord.title).trim(),
    subtitle: post.subtitle?.trim() || null,
    publishedAt: isoOrNull(post.post_date) ?? feedRecord.publishedAt ?? null,
    updatedAt: isoOrNull(post.updated_at),
    medium,
    representation: recording ? "recording" : "article",
    feed: options.feedRef,
    text: { role: recording ? "description" : "article", content: articleText },
    transcript,
    analysis,
    attribution: resolveAttribution(observed, feed),
    thumbnail,
    images,
    original: { post: "post.raw" },
    warnings,
  };
  assets.push({ file: "post.raw", content: JSON.stringify(sanitisePost(rawJson)) });
  if (transcriptOriginal) assets.push({ file: "transcript.raw", content: transcriptOriginal });
  return { record, assets };
}
