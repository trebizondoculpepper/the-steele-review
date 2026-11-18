import { convert } from "html-to-text";
import { z } from "zod";
import type { SubstackItem } from "../../content/substack-item.js";
import {
  DiscoveryFetchError,
  boundedFetchText,
  parseConfiguredUrl,
  type BoundedFetchOptions,
} from "./http.js";

/**
 * Content acquisition for one discovered public post, behind the Substack
 * controller boundary. Uses the public post endpoint (`/api/v1/posts/<slug>`)
 * and prefers the transcript Substack already supplies (a signed CDN link to
 * timed segments) over any transcription. When no supplied transcript exists
 * for audio/video content, it returns a media reference: audio first, video
 * as the fallback. It never downloads media, bypasses access restrictions,
 * publishes events or indexes anything.
 *
 * Signed CDN URLs are used for the single fetch and never returned, because
 * they are ephemeral credentials.
 */

export const SUBSTACK_CDN_HOST = "substackcdn.com";

export interface TranscriptSegment {
  /** Seconds from the start of the media. */
  start: number;
  end: number;
  text: string;
}

export interface CollectionProvenance {
  sourceUrl: string;
  acquiredAt: string;
  method: "supplied-transcript" | "article-html" | "supplied-transcript+article-html";
  /** Substack media upload the transcript belongs to, when applicable. */
  mediaUploadId?: string;
  transcriptLanguage?: string;
  /** "aligned" segments carry timestamps from Substack's aligned transcript. */
  transcriptVariant?: "aligned";
  postType?: string;
  audience?: string;
}

export interface TextAcquired {
  kind: "text";
  item: SubstackItem;
  /** Supplied text exactly as received. */
  supplied: {
    articleHtml?: string;
    /** Normalised timed segments (start, end, text) derived from the document below. */
    transcript?: TranscriptSegment[];
    /** The supplied transcript document exactly as received, including word timings. */
    transcriptDocument?: string;
  };
  /** Plain normalised text: article text, then transcript text. */
  text: string;
  /** False when the article body is known to be truncated. */
  complete: boolean;
  provenance: CollectionProvenance;
}

export interface TranscriptionRequired {
  kind: "transcription-required";
  item: SubstackItem;
  media:
    | { kind: "audio"; url: string; durationSeconds?: number }
    | { kind: "video"; uploadId: string; durationSeconds?: number };
  /** Accessible article text to keep alongside the future transcript. */
  articleText?: string;
  provenance: Omit<CollectionProvenance, "method">;
}

export interface ContentUnavailable {
  kind: "unavailable";
  item: SubstackItem;
  reason: "not-found" | "restricted" | "no-content" | "malformed-response";
  /** Partial accessible text, e.g. a paywalled preview. */
  partialText?: string;
}

export interface TransientFailure {
  kind: "transient-failure";
  item: SubstackItem;
  /** Sanitised reason; never a URL or raw client message. */
  reason: string;
}

export type CollectionResult =
  | TextAcquired
  | TranscriptionRequired
  | ContentUnavailable
  | TransientFailure;

const TranscriptionSchema = z.looseObject({
  status: z.string().optional(),
  language: z.string().nullable().optional(),
  cdn_url: z.string().nullable().optional(),
  media_upload_id: z.string().optional(),
});
const UploadSchema = z
  .looseObject({
    id: z.string().optional(),
    duration: z.number().nullable().optional(),
    transcription: TranscriptionSchema.nullable().optional(),
  })
  .nullable()
  .optional();
const PostSchema = z.looseObject({
  slug: z.string(),
  canonical_url: z.string().optional(),
  type: z.string().optional(),
  audience: z.string().optional(),
  body_html: z.string().nullable().optional(),
  truncated_body_text: z.string().nullable().optional(),
  podcast_url: z.string().nullable().optional(),
  podcast_duration: z.number().nullable().optional(),
  podcastUpload: UploadSchema,
  videoUpload: UploadSchema,
});
type Post = z.infer<typeof PostSchema>;

const SegmentsSchema = z
  .array(
    z.looseObject({
      start: z.number().nonnegative(),
      end: z.number().nonnegative(),
      text: z.string(),
    }),
  )
  .min(1);

export interface CollectorConfig {
  /** Public HTTPS publication base URL (runtime configuration). */
  publicationUrl: string;
  timeoutMs?: number;
  /** Response size bound for post and transcript documents. */
  maxBytes?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: BoundedFetchOptions["sleep"];
  now?: () => Date;
}

/** Convert article HTML to plain text, keeping link destinations and dropping images. */
export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      // Keep link destinations: cited evidence must stay followable in the text.
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "img", format: "skip" },
      { selector: "figure", format: "skip" },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function transcriptText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
}

function isPermanentHttpFailure(error: unknown): boolean {
  return error instanceof DiscoveryFetchError && /HTTP status (40[134]|410)/.test(error.message);
}

export class SubstackContentCollector {
  private readonly base: URL;
  private readonly publicationOptions: BoundedFetchOptions;
  private readonly cdnOptions: BoundedFetchOptions;
  private readonly now: () => Date;

  constructor(config: CollectorConfig) {
    this.base = parseConfiguredUrl(config.publicationUrl, "publicationUrl");
    const common = {
      timeoutMs: config.timeoutMs ?? 15_000,
      maxBytes: config.maxBytes ?? 10 * 1024 * 1024,
      maxAttempts: config.maxAttempts ?? 3,
      maxRedirects: 2,
      retryDelayMs: config.retryDelayMs ?? 1_000,
      accept: "application/json",
      fetch: config.fetch,
      sleep: config.sleep,
    };
    this.publicationOptions = {
      ...common,
      allowedHosts: new Set([this.base.hostname.toLowerCase()]),
    };
    this.cdnOptions = { ...common, allowedHosts: new Set([SUBSTACK_CDN_HOST]) };
    this.now = config.now ?? (() => new Date());
  }

  async collect(item: SubstackItem, signal?: AbortSignal): Promise<CollectionResult> {
    const postUrl = new URL(`/api/v1/posts/${encodeURIComponent(item.postId)}`, this.base);
    let post: Post;
    try {
      const body = await boundedFetchText(postUrl, this.publicationOptions, signal);
      const parsed = PostSchema.safeParse(JSON.parse(body));
      if (!parsed.success || parsed.data.slug.toLowerCase() !== item.postId) {
        return { kind: "unavailable", item, reason: "malformed-response" };
      }
      post = parsed.data;
    } catch (error) {
      return this.failure(item, error);
    }

    const baseProvenance = {
      sourceUrl: item.url,
      acquiredAt: this.now().toISOString(),
      postType: post.type,
      audience: post.audience,
    };
    const restricted = post.audience !== undefined && post.audience !== "everyone";
    const articleHtml = post.body_html?.trim() || undefined;
    const articleText = articleHtml ? htmlToPlainText(articleHtml) : undefined;
    const upload = [post.podcastUpload, post.videoUpload].find(
      (u) => u?.transcription?.status === "transcribed" && u.transcription.cdn_url,
    );

    if (upload?.transcription?.cdn_url && !restricted) {
      let transcript: { segments: TranscriptSegment[]; document: string } | undefined;
      try {
        transcript = await this.fetchTranscript(upload.transcription.cdn_url, signal);
      } catch (error) {
        // A missing, expired or forbidden transcript document means no usable
        // supplied transcript; only transient failures abort collection.
        if (!isPermanentHttpFailure(error)) return this.failure(item, error);
      }
      if (transcript) {
        const text = [articleText, transcriptText(transcript.segments)]
          .filter(Boolean)
          .join("\n\n");
        return {
          kind: "text",
          item,
          supplied: {
            articleHtml,
            transcript: transcript.segments,
            transcriptDocument: transcript.document,
          },
          text,
          complete: true,
          provenance: {
            ...baseProvenance,
            method: articleHtml ? "supplied-transcript+article-html" : "supplied-transcript",
            mediaUploadId: upload.transcription.media_upload_id ?? upload.id,
            transcriptLanguage: upload.transcription.language ?? undefined,
            transcriptVariant: "aligned",
          },
        };
      }
    }

    if (restricted) {
      const partialText = articleText || post.truncated_body_text?.trim() || undefined;
      return { kind: "unavailable", item, reason: "restricted", partialText };
    }

    const media = this.mediaReference(post);
    if (media) {
      return {
        kind: "transcription-required",
        item,
        media,
        articleText: articleText || undefined,
        provenance: baseProvenance,
      };
    }
    if (articleText) {
      // A media post whose transcript and media are both unusable still has its
      // description, but the substantive content is missing: not complete.
      const isMediaPost =
        post.type === "podcast" ||
        post.type === "video" ||
        Boolean(post.podcastUpload) ||
        Boolean(post.videoUpload);
      return {
        kind: "text",
        item,
        supplied: { articleHtml },
        text: articleText,
        complete: !isMediaPost,
        provenance: { ...baseProvenance, method: "article-html" },
      };
    }
    return { kind: "unavailable", item, reason: "no-content" };
  }

  /** Fetch supplied transcript segments, or undefined if the document is unusable. */
  private async fetchTranscript(
    cdnUrl: string,
    signal?: AbortSignal,
  ): Promise<{ segments: TranscriptSegment[]; document: string } | undefined> {
    let url: URL;
    try {
      url = new URL(cdnUrl);
    } catch {
      return undefined;
    }
    if (url.protocol !== "https:" || url.hostname !== SUBSTACK_CDN_HOST) return undefined;
    const body = await boundedFetchText(url, this.cdnOptions, signal);
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return undefined;
    }
    const parsed = SegmentsSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const segments = parsed.data.map(({ start, end, text }) => ({ start, end, text }));
    return transcriptText(segments) ? { segments, document: body } : undefined;
  }

  /** Audio before video; only HTTPS audio references are returned. */
  private mediaReference(post: Post): TranscriptionRequired["media"] | undefined {
    if (post.podcast_url) {
      try {
        const audio = new URL(post.podcast_url);
        if (audio.protocol === "https:") {
          return {
            kind: "audio",
            url: audio.href,
            durationSeconds: post.podcast_duration ?? undefined,
          };
        }
      } catch {
        // fall through to video
      }
    }
    if (post.videoUpload?.id) {
      return {
        kind: "video",
        uploadId: post.videoUpload.id,
        durationSeconds: post.videoUpload.duration ?? undefined,
      };
    }
    return undefined;
  }

  private failure(item: SubstackItem, error: unknown): CollectionResult {
    if (error instanceof DiscoveryFetchError) {
      if (/HTTP status 404|HTTP status 410/.test(error.message)) {
        return { kind: "unavailable", item, reason: "not-found" };
      }
      if (/HTTP status 40[13]/.test(error.message)) {
        return { kind: "unavailable", item, reason: "restricted" };
      }
      return { kind: "transient-failure", item, reason: error.message };
    }
    if (error instanceof SyntaxError) {
      return { kind: "unavailable", item, reason: "malformed-response" };
    }
    return { kind: "transient-failure", item, reason: "request failed" };
  }
}
