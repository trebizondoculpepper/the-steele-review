import { z } from "zod";
import { postByline } from "./byline.js";
import {
  SubstackItemSchema,
  postIdFromCanonicalUrl,
  type SubstackItem,
} from "../../content/substack-item.js";
import {
  DiscoveryFetchError,
  abortableSleep,
  boundedFetchText,
  parseConfiguredUrl,
  type BoundedFetchOptions,
} from "./http.js";

/**
 * Historical discovery for one Substack publication through the public archive
 * listing (`/api/v1/archive`, newest first, cursor pagination, at most 25 per
 * page). This is an observed web endpoint, not a documented contract: the
 * response is validated at this boundary and any unexpected shape stops
 * enumeration as incomplete rather than guessing. See
 * doc/findings/substack-archive-discovery.md for measured coverage.
 *
 * Emits metadata only. No NATS calls, article bodies or media downloads.
 */

export const MAX_ARCHIVE_PAGE_SIZE = 25;

export interface ArchiveDiscoveryConfig {
  /** Public HTTPS publication base URL, e.g. https://example.substack.com/ (runtime config). */
  publicationUrl: string;
  /** Normalised publication ID for emitted items. */
  publicationId: string;
  pageSize?: number;
  /** Minimum delay between page requests (rate limit). */
  minRequestIntervalMs?: number;
  /** Hard cap on pages per enumeration, independent of item bounds. */
  maxPages?: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onSkippedEntry?: (reason: string) => void;
}

export interface HistoricalOptions {
  /** Required positive upper bound on emitted items. */
  maxItems: number;
  /** Emit only posts published at or after this time. */
  since?: Date;
  /** Emit only posts published at or before this time. */
  until?: Date;
  signal?: AbortSignal;
  /** Called once when enumeration ends normally. */
  onComplete?: (summary: EnumerationSummary) => void;
}

export type CompletionReason = "exhausted" | "count-limit" | "date-limit";

export interface EnumerationSummary {
  reason: CompletionReason;
  pages: number;
  emitted: number;
  /** Items repeated across pages and suppressed. */
  duplicates: number;
  skipped: number;
}

/** Enumeration stopped before reaching a bound or the end of the archive. */
export class IncompleteEnumerationError extends Error {
  constructor(
    readonly cause_: string,
    readonly summary: Omit<EnumerationSummary, "reason">,
  ) {
    super(`historical enumeration incomplete: ${cause_}`);
    this.name = "IncompleteEnumerationError";
  }
}

const ArchivePostSchema = z.looseObject({
  slug: z.string().optional(),
  canonical_url: z.string().optional(),
  title: z.string().nullable().optional(),
  post_date: z.string().nullable().optional(),
});
const ArchivePageSchema = z.looseObject({
  posts: z.array(z.unknown()),
  nextCursor: z.string().min(1).nullable().optional(),
});

function toIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Normalise one archive entry, or return a sanitised skip reason. */
export function normaliseArchivePost(
  raw: unknown,
  publicationId: string,
): SubstackItem | { skip: string } {
  const post = ArchivePostSchema.safeParse(raw);
  if (!post.success) return { skip: "entry has unexpected shape" };
  const url = post.data.canonical_url?.trim();
  const slug = post.data.slug?.trim().toLowerCase();
  const postId = slug || (url ? postIdFromCanonicalUrl(url) : undefined);
  if (!url || !postId) return { skip: "entry has no canonical post URL" };
  const candidate: Record<string, unknown> = {
    publicationId,
    postId,
    url,
    title: post.data.title?.trim(),
  };
  const publishedAt = toIso(post.data.post_date);
  const author = postByline(post.data.publishedBylines);
  if (author) candidate.author = author;
  if (publishedAt) candidate.publishedAt = publishedAt;
  const parsed = SubstackItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { skip: "entry failed metadata validation" };
}

export class SubstackArchiveDiscovery {
  private readonly endpoint: URL;
  private readonly pageSize: number;
  private readonly interval: number;
  private readonly maxPages: number;
  private readonly fetchOptions: BoundedFetchOptions;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly config: ArchiveDiscoveryConfig) {
    SubstackItemSchema.shape.publicationId.parse(config.publicationId);
    this.endpoint = new URL(
      "/api/v1/archive",
      parseConfiguredUrl(config.publicationUrl, "publicationUrl"),
    );
    this.pageSize = z
      .number()
      .int()
      .min(1)
      .max(MAX_ARCHIVE_PAGE_SIZE)
      .parse(config.pageSize ?? MAX_ARCHIVE_PAGE_SIZE);
    this.interval = z
      .number()
      .min(0)
      .parse(config.minRequestIntervalMs ?? 1_000);
    this.maxPages = z
      .number()
      .int()
      .positive()
      .parse(config.maxPages ?? 1_000);
    this.sleep = config.sleep ?? abortableSleep;
    this.fetchOptions = {
      allowedHosts: new Set([this.endpoint.hostname.toLowerCase()]),
      timeoutMs: config.timeoutMs ?? 15_000,
      maxBytes: config.maxBytes ?? 10 * 1024 * 1024,
      maxAttempts: config.maxAttempts ?? 3,
      maxRedirects: 2,
      retryDelayMs: config.retryDelayMs ?? 2_000,
      accept: "application/json",
      fetch: config.fetch,
      sleep: this.sleep,
    };
  }

  /**
   * Enumerate archive posts newest first within the given bounds. Ends
   * normally only on exhausting the archive or reaching a bound (reported via
   * `onComplete`); any other stop throws IncompleteEnumerationError.
   */
  async *getHistoricalItems(options: HistoricalOptions): AsyncIterable<SubstackItem> {
    const maxItems = z.number().int().positive().parse(options.maxItems);
    if (options.since && options.until && options.since > options.until) {
      throw new RangeError("since must not be after until");
    }
    const { signal } = options;
    const seenCursors = new Set<string>();
    const seenPosts = new Set<string>();
    const stats = { pages: 0, emitted: 0, duplicates: 0, skipped: 0 };
    let cursor: string | undefined;
    const fail = (cause: string): never => {
      throw new IncompleteEnumerationError(cause, { ...stats });
    };

    for (;;) {
      if (signal?.aborted) fail("cancelled");
      if (stats.pages >= this.maxPages) fail("page limit reached before a bound");
      if (stats.pages > 0 && this.interval > 0) {
        try {
          await this.sleep(this.interval, signal);
        } catch {
          fail("cancelled");
        }
      }

      const url = new URL(this.endpoint);
      url.searchParams.set("sort", "new");
      url.searchParams.set("limit", String(this.pageSize));
      if (cursor) url.searchParams.set("cursor", cursor);

      let body: string;
      try {
        body = await boundedFetchText(url, this.fetchOptions, signal);
      } catch (error) {
        fail(error instanceof DiscoveryFetchError ? error.message : "request failed");
      }
      let page: z.infer<typeof ArchivePageSchema>;
      try {
        page = ArchivePageSchema.parse(JSON.parse(body!));
      } catch {
        fail("archive page has unexpected shape");
      }
      stats.pages++;

      for (const raw of page!.posts) {
        const item = normaliseArchivePost(raw, this.config.publicationId);
        if ("skip" in item) {
          stats.skipped++;
          this.config.onSkippedEntry?.(item.skip);
          continue;
        }
        if (seenPosts.has(item.postId)) {
          stats.duplicates++;
          continue;
        }
        seenPosts.add(item.postId);
        const published = item.publishedAt ? new Date(item.publishedAt) : undefined;
        if ((options.since || options.until) && !published) {
          stats.skipped++;
          this.config.onSkippedEntry?.("entry has no date inside a date-bounded run");
          continue;
        }
        if (options.until && published && published > options.until) continue;
        if (options.since && published && published < options.since) {
          options.onComplete?.({ reason: "date-limit", ...stats });
          return;
        }
        if (signal?.aborted) fail("cancelled");
        yield item;
        stats.emitted++;
        if (stats.emitted >= maxItems) {
          options.onComplete?.({ reason: "count-limit", ...stats });
          return;
        }
      }

      // An empty page with a cursor is not the end: keep following it. The
      // repeated-cursor check and page cap bound any loop of empty pages.
      const next = page!.nextCursor ?? undefined;
      if (!next) {
        options.onComplete?.({ reason: "exhausted", ...stats });
        return;
      }
      if (seenCursors.has(next)) fail("archive repeated a page cursor");
      seenCursors.add(next);
      cursor = next;
    }
  }
}
