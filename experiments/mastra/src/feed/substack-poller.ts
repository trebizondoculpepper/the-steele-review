import type { ConfigReader } from "../common/config/index.js";
import { GitError, type GitRepository } from "../common/git/index.js";
import { FeedFetchError, fetchFeedXml } from "./fetch-feed.js";
import { FeedError, parseFeed, type FeedItem } from "./rss.js";
import { enabledSubstackFeeds, type SubstackFeed } from "./substack-sources.js";

/**
 * The Git-backed Substack poller (#943).
 *
 * One pass reads the source configuration, polls every enabled Substack feed
 * and keeps one feed-discovery record per observed item in the `feeds`
 * collection of the collections repository:
 *
 *   feeds/<sourceId>/<itemId>.json
 *
 * The item ID is the post's slug, the stable part of its canonical URL, which
 * is the discovery key (see rss.ts). A record holds the original URL, the
 * title, the publication date when the feed gives one, and the feed metadata
 * used to detect edits (the fingerprint). It holds no poll time, so polling an
 * unchanged item rewrites nothing.
 *
 * All new and changed records from one pass go into a single commit through
 * the common Git service; an unchanged pass makes no commit. The first pass
 * records every item it sees. A feed that fails is reported in its summary
 * and the other feeds' results are still committed.
 *
 * The pass never fetches posts, captures content, indexes or publishes.
 */

export const FEEDS_COLLECTION = "feeds";
export const RECORD_SCHEMA_VERSION = 1;

/** The `feeds` collection's declaration for the collection indexer (#942). */
export const FEEDS_DECLARATION = {
  mappingVersion: 1,
  mapping: {
    dynamic: "strict",
    properties: {
      schemaVersion: { type: "integer" },
      sourceId: { type: "keyword" },
      itemId: { type: "keyword" },
      url: { type: "keyword" },
      canonicalUrl: { type: "keyword" },
      title: { type: "text" },
      publishedAt: { type: "date" },
      postId: { type: "keyword" },
      sourceItem: { type: "keyword" },
      medium: { type: "keyword" },
      fingerprint: { type: "keyword" },
    },
  },
} as const;

export interface FeedRecord {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  sourceId: string;
  itemId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  publishedAt?: string;
  postId?: string;
  sourceItem?: string;
  medium: FeedItem["medium"];
  fingerprint: string;
}

export interface SourceSummary {
  sourceId: string;
  status: "ok" | "failed";
  /** Failure category, never a URL or response body. */
  error?: string;
  items: number;
  new: number;
  changed: number;
  unchanged: number;
}

export interface CommittedRecord {
  sourceId: string;
  itemId: string;
  path: string;
  change: "new" | "changed";
  commit: string;
}

export interface PollReport {
  /** True when every enabled feed was polled successfully. */
  ok: boolean;
  /** The commit holding this pass's records, or null when nothing changed. */
  commit: string | null;
  sources: SourceSummary[];
  committed: CommittedRecord[];
}

export interface PollerOptions {
  config: ConfigReader;
  repo: GitRepository;
  branch?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Retries when another writer moves the branch during the commit. */
  maxCommitAttempts?: number;
}

export function recordPath(sourceId: string, itemId: string): string {
  return `${FEEDS_COLLECTION}/${sourceId}/${itemId}.json`;
}

export function toRecord(sourceId: string, item: FeedItem): FeedRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    sourceId,
    itemId: item.slug,
    url: item.link,
    canonicalUrl: item.canonicalUrl,
    title: item.title,
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(item.postId ? { postId: item.postId } : {}),
    ...(item.sourceItem ? { sourceItem: item.sourceItem } : {}),
    medium: item.medium,
    fingerprint: item.fingerprint,
  };
}

const serialise = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

interface Polled {
  feed: SubstackFeed;
  records?: FeedRecord[];
  error?: string;
}

async function pollOne(feed: SubstackFeed, options: PollerOptions): Promise<Polled> {
  try {
    const xml = await fetchFeedXml(feed.feedUrl, { fetch: options.fetch, timeoutMs: options.timeoutMs });
    const seen = new Set<string>();
    const records: FeedRecord[] = [];
    for (const item of parseFeed(xml, feed.publicationHost)) {
      // A feed listing the same post twice keeps its first entry.
      if (seen.has(item.slug)) continue;
      seen.add(item.slug);
      records.push(toRecord(feed.sourceId, item));
    }
    return { feed, records };
  } catch (error) {
    if (error instanceof FeedFetchError) return { feed, error: error.category };
    if (error instanceof FeedError) return { feed, error: error.code };
    return { feed, error: "feed-failed" };
  }
}

/** Poll every enabled Substack feed and commit new or changed discovery records. */
export async function pollSubstackFeeds(options: PollerOptions): Promise<PollReport> {
  const feeds = await enabledSubstackFeeds(options.config);
  const polled: Polled[] = [];
  for (const feed of feeds) polled.push(await pollOne(feed, options));

  const branch = options.branch ?? "main";
  const attempts = options.maxCommitAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    const head = await options.repo.resolve(`refs/heads/${branch}`);
    const sources: SourceSummary[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    const pending: Array<Omit<CommittedRecord, "commit">> = [];

    if (polled.some((p) => p.records?.length)) {
      const declarationPath = `${FEEDS_COLLECTION}/collection.json`;
      const declaration = serialise(FEEDS_DECLARATION);
      const existing = head ? await options.repo.readText(head, declarationPath) : null;
      // An existing declaration is the collection owner's; it is never overwritten.
      if (!existing) writes.push({ path: declarationPath, content: declaration });
    }

    for (const { feed, records, error } of polled) {
      if (!records) {
        sources.push({ sourceId: feed.sourceId, status: "failed", error, items: 0, new: 0, changed: 0, unchanged: 0 });
        continue;
      }
      const summary: SourceSummary = { sourceId: feed.sourceId, status: "ok", items: records.length, new: 0, changed: 0, unchanged: 0 };
      for (const record of records) {
        const path = recordPath(feed.sourceId, record.itemId);
        const content = serialise(record);
        const current = head ? await options.repo.readText(head, path) : null;
        if (current?.text === content) {
          summary.unchanged++;
          continue;
        }
        const change = current ? "changed" : "new";
        summary[change]++;
        writes.push({ path, content });
        pending.push({ sourceId: feed.sourceId, itemId: record.itemId, path, change });
      }
      sources.push(summary);
    }

    const ok = sources.every((s) => s.status === "ok");
    if (pending.length === 0) return { ok, commit: null, sources, committed: [] };
    const counts = sources.reduce((n, s) => ({ new: n.new + s.new, changed: n.changed + s.changed }), { new: 0, changed: 0 });
    try {
      const result = await options.repo.commit({
        branch,
        parent: head,
        writes,
        message: `Poll Substack feeds: ${counts.new} new, ${counts.changed} changed`,
      });
      return { ok, commit: result.commit, sources, committed: pending.map((p) => ({ ...p, commit: result.commit! })) };
    } catch (error) {
      // Another writer moved the branch: recompute against its new head.
      if (error instanceof GitError && error.code === "conflict" && attempt < attempts) continue;
      throw error;
    }
  }
}
