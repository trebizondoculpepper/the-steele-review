import Parser from "rss-parser";
import {
  SubstackItemSchema,
  normalisePostAuthor,
  postIdFromCanonicalUrl,
  type SubstackItem,
} from "../../content/substack-item.js";
import { boundedFetchText, parseConfiguredUrl, type BoundedFetchOptions } from "./http.js";

/**
 * Recent-items discovery for one Substack publication from its public RSS
 * feed. Emits every entry in the fetched feed as a normalised SubstackItem.
 * Protocol details (RSS, HTTP) stay inside this controller; callers see only
 * AsyncIterable<SubstackItem>. No NATS calls and no article or media download.
 */

export interface RssDiscoveryConfig {
  /** Public HTTPS feed URL; runtime configuration, never hard-coded. */
  feedUrl: string;
  /** Normalised publication ID (lower-case subdomain) for emitted items. */
  publicationId: string;
  /** Extra hosts redirects may reach; the feed host is always allowed. */
  extraAllowedHosts?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxAttempts?: number;
  maxRedirects?: number;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: BoundedFetchOptions["sleep"];
  /** Sanitised notice for an entry that could not be normalised. */
  onSkippedEntry?: (reason: string, index: number) => void;
}

export class FeedParseError extends Error {
  constructor() {
    super("feed could not be parsed as RSS");
    this.name = "FeedParseError";
  }
}

const parser = new Parser();

/** Convert a feed date to ISO 8601, or undefined when absent or unparseable. */
function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * Normalise parsed feed entries. Entries missing a usable URL, post ID or
 * title are skipped and reported; absent dates stay absent.
 */
export function normaliseFeedItems(
  items: Parser.Item[],
  publicationId: string,
  onSkippedEntry?: (reason: string, index: number) => void,
): SubstackItem[] {
  const result: SubstackItem[] = [];
  items.forEach((entry, index) => {
    // Prefer the link; fall back to a canonical guid URL when the link is absent or unusable.
    const candidates = [entry.link?.trim(), entry.guid?.trim()].filter((value): value is string =>
      Boolean(value),
    );
    const url = candidates.find((value) => postIdFromCanonicalUrl(value) !== undefined);
    const postId = url ? postIdFromCanonicalUrl(url) : undefined;
    if (!url || !postId) {
      onSkippedEntry?.("entry has no canonical post URL", index);
      return;
    }
    const candidate = {
      publicationId,
      postId,
      url,
      title: entry.title?.trim(),
      publishedAt: isoDate(entry.isoDate ?? entry.pubDate),
      author: normalisePostAuthor(entry.creator),
    };
    if (candidate.publishedAt === undefined) delete candidate.publishedAt;
    const parsed = SubstackItemSchema.safeParse(candidate);
    if (!parsed.success) {
      onSkippedEntry?.("entry failed metadata validation", index);
      return;
    }
    result.push(parsed.data);
  });
  return result;
}

/** Parse RSS XML text into normalised items. Throws FeedParseError if malformed. */
export async function parseFeed(
  xml: string,
  publicationId: string,
  onSkippedEntry?: (reason: string, index: number) => void,
): Promise<SubstackItem[]> {
  let feed: Parser.Output<Parser.Item>;
  try {
    feed = await parser.parseString(xml);
  } catch {
    throw new FeedParseError();
  }
  if (!Array.isArray(feed.items)) throw new FeedParseError();
  return normaliseFeedItems(feed.items, publicationId, onSkippedEntry);
}

export class SubstackRssDiscovery {
  private readonly feedUrl: URL;
  private readonly fetchOptions: BoundedFetchOptions;

  constructor(private readonly config: RssDiscoveryConfig) {
    SubstackItemSchema.shape.publicationId.parse(config.publicationId);
    this.feedUrl = parseConfiguredUrl(config.feedUrl, "feedUrl");
    const allowedHosts = new Set(
      [this.feedUrl.hostname, ...(config.extraAllowedHosts ?? [])].map((h) => h.toLowerCase()),
    );
    this.fetchOptions = {
      allowedHosts,
      timeoutMs: config.timeoutMs ?? 10_000,
      maxBytes: config.maxBytes ?? 5 * 1024 * 1024,
      maxAttempts: config.maxAttempts ?? 3,
      maxRedirects: config.maxRedirects ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1_000,
      fetch: config.fetch,
      sleep: config.sleep,
    };
  }

  /** Fetch the feed once and yield every normalisable entry, newest first as published. */
  async *getRecentItems(signal?: AbortSignal): AsyncIterable<SubstackItem> {
    const xml = await boundedFetchText(this.feedUrl, this.fetchOptions, signal);
    const items = await parseFeed(xml, this.config.publicationId, this.config.onSkippedEntry);
    for (const item of items) {
      signal?.throwIfAborted();
      yield item;
    }
  }
}
