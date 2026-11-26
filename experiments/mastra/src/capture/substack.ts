import { convert } from "html-to-text";
import { z } from "zod";
import { canonicalPostUrl } from "../feed/rss.js";
import { normaliseText, SourceBundleSchema, type SourceBundle } from "./bundle.js";

/**
 * Narrow capture adapter for one public Substack post (#920).
 *
 * - Reads the public post endpoint (`/api/v1/posts/<slug>`) on the allowed
 *   publication host.
 * - Prefers the transcript Substack already supplies for audio and video.
 *   It is fetched once from the signed CDN link, which is never stored,
 *   logged or returned. Otherwise it uses the article HTML's plain text.
 * - No paid transcription and no media downloads. A post with neither text
 *   source is captured honestly with an empty text and a `no-usable-text`
 *   warning, never invented content.
 * - Fetched content is untrusted: responses are size-bounded, redirects are
 *   refused, and shapes are validated.
 */

export const SUBSTACK_CDN_HOST = "substackcdn.com";
const MAX_BYTES = 5_000_000;

export class CaptureError extends Error {
  readonly code: "post-not-found" | "post-unavailable" | "invalid-post" | "wrong-publication" | "restricted";
  constructor(code: CaptureError["code"], message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const Upload = z
  .looseObject({
    id: z.string().optional(),
    transcription: z
      .looseObject({ status: z.string().optional(), cdn_url: z.string().nullable().optional(), media_upload_id: z.string().optional() })
      .nullable()
      .optional(),
  })
  .nullable()
  .optional();

const PostSchema = z.looseObject({
  id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String),
  slug: z.string(),
  title: z.string().nullable().optional(),
  type: z.string().optional(),
  audience: z.string().optional(),
  post_date: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  body_html: z.string().nullable().optional(),
  podcast_url: z.string().nullable().optional(),
  podcastUpload: Upload,
  videoUpload: Upload,
  publishedBylines: z.array(z.looseObject({ name: z.string().optional() })).nullable().optional(),
});

const Segments = z.array(z.looseObject({ start: z.number(), end: z.number(), text: z.string() })).min(1);

export interface CaptureResult {
  bundle: SourceBundle;
  /** Original post JSON as received, with signed links removed. */
  rawPost: string;
  /** Original supplied transcript JSON, when one was used. */
  rawTranscript: string | null;
  warnings: string[];
}

export interface CaptureConfig {
  publicationHost: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

async function boundedText(url: URL, cfg: CaptureConfig): Promise<{ status: number; body: string }> {
  const res = await (cfg.fetch ?? fetch)(url, {
    redirect: "error",
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
    headers: { accept: "application/json" },
  });
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CaptureError("invalid-post", "response too large");
      }
      chunks.push(value);
    }
  return { status: res.status, body: new TextDecoder().decode(Buffer.concat(chunks)) };
}

function isoOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Removes signed URLs (ephemeral credentials) from the retained post JSON. */
function sanitisePost(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(sanitisePost);
  if (raw && typeof raw === "object")
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) =>
        typeof v === "string" && (k === "cdn_url" || /^https?:\/\/[^ ]*[?&](Expires|Signature|X-Amz-Signature|Key-Pair-Id)=/i.test(v)) ? [k, "[signed-url-removed]"] : [k, sanitisePost(v)],
      ),
    );
  return raw;
}

export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "img", format: "skip" },
      { selector: "figure", format: "skip" },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function capturePost(postUrl: string, cfg: CaptureConfig): Promise<CaptureResult> {
  const canonical = canonicalPostUrl(postUrl, cfg.publicationHost);
  const slug = canonical.pathname.slice(3);
  const publication = cfg.publicationHost.split(".")[0]!;
  let res: { status: number; body: string };
  try {
    res = await boundedText(new URL(`/api/v1/posts/${encodeURIComponent(slug)}`, canonical), cfg);
  } catch (e) {
    if (e instanceof CaptureError) throw e;
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
  const audience = post.audience ?? "everyone";
  if (audience !== "everyone") throw new CaptureError("restricted", "post is not public");

  const medium: SourceBundle["medium"] =
    post.videoUpload?.id || post.type === "video"
      ? "video"
      : post.podcastUpload?.id || post.type === "podcast" || post.type === "audio"
        ? "audio"
        : (post.type === "newsletter" || post.type === "text") && !post.podcast_url
          ? "written"
          : "unknown";
  const warnings: string[] = [];
  const upload = [post.podcastUpload, post.videoUpload].find((u) => u?.transcription?.status === "transcribed" && u.transcription.cdn_url);

  let text = "";
  let textSource: SourceBundle["textSource"] = "article-html";
  let rawTranscript: string | null = null;
  let mediaUploadId: string | null = post.videoUpload?.id ?? post.podcastUpload?.id ?? null;
  if (upload?.transcription?.cdn_url) {
    const cdn = new URL(upload.transcription.cdn_url);
    if (cdn.protocol === "https:" && cdn.hostname === SUBSTACK_CDN_HOST) {
      try {
        const t = await boundedText(cdn, cfg);
        const segs = t.status === 200 ? Segments.safeParse(JSON.parse(t.body)) : undefined;
        if (segs?.success) {
          text = segs.data
            .map((s) => s.text.trim())
            .filter(Boolean)
            .join("\n");
          textSource = "supplied-transcript";
          rawTranscript = t.body;
          mediaUploadId = upload.transcription.media_upload_id ?? upload.id ?? mediaUploadId;
        } else warnings.push("supplied-transcript-unusable");
      } catch {
        warnings.push("supplied-transcript-unavailable");
      }
    } else warnings.push("supplied-transcript-host-not-allowed");
  }
  if (textSource !== "supplied-transcript" && post.body_html?.trim()) {
    text = htmlToPlainText(post.body_html);
    if (medium === "audio" || medium === "video") warnings.push("text-is-article-description-not-transcript");
  }
  text = normaliseText(text);
  if (!text) warnings.push("no-usable-text");

  const bylines = (post.publishedBylines ?? []).map((b) => b.name?.trim()).filter((n): n is string => Boolean(n));
  const bundle = SourceBundleSchema.parse({
    schema: "source-bundle-v1",
    item: `substack:${publication}:${post.id}`,
    postId: post.id,
    slug,
    url: canonical.href,
    title: (post.title ?? "").trim(),
    publishedAt: isoOrNull(post.post_date),
    updatedAt: isoOrNull(post.updated_at),
    author: bylines.length === 1 ? bylines[0]! : null,
    medium,
    audience,
    mediaUploadId,
    textSource,
    text,
  });
  return { bundle, rawPost: JSON.stringify(sanitisePost(rawJson)), rawTranscript, warnings };
}
