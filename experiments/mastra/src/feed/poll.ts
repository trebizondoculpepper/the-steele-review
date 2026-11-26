import { randomUUID } from "node:crypto";
import { FeedError, parseFeed, type FeedItem } from "./rss.js";
import type { FeedStore } from "./store.js";

/**
 * One bounded, read-only poll of the configured feed (#919). It records what
 * it saw and returns new and changed items. It never fetches posts, writes
 * articles or delivers anything.
 */

export interface FeedConfig {
  /** Feed URL; its host must be the allowed publication host or the configured fixture host. */
  feedUrl: string;
  publicationHost: string;
  /** Extra host allowed for a controlled fixture feed (tests and bounded checks only). */
  fixtureHost?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface PollResult {
  pollId: string;
  outcome: "ok" | "failed";
  baseline: boolean;
  httpStatus: number | null;
  itemCount: number;
  newItems: FeedItem[];
  changedItems: FeedItem[];
  unchangedCount: number;
  error: string | null;
  durationMs: number;
}

const MAX_BYTES = 5_000_000;

export function feedConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FeedConfig {
  return {
    feedUrl: env.STEELE_EXP_MASTRA_FEED_URL ?? "https://saveusnow.substack.com/feed",
    publicationHost: env.STEELE_EXP_MASTRA_PUBLICATION_HOST ?? "saveusnow.substack.com",
    ...(env.STEELE_EXP_MASTRA_FIXTURE_FEED_HOST ? { fixtureHost: env.STEELE_EXP_MASTRA_FIXTURE_FEED_HOST } : {}),
  };
}

export async function pollFeed(store: FeedStore, config: FeedConfig): Promise<PollResult> {
  const now = config.now ?? (() => new Date());
  const pollId = `poll-${randomUUID()}`;
  const started = now();
  let httpStatus: number | null = null;
  const fail = async (error: string): Promise<PollResult> => {
    const finished = now();
    await store.recordFailure({ pollId, startedAt: started.toISOString(), finishedAt: finished.toISOString(), httpStatus, error });
    return {
      pollId,
      outcome: "failed",
      baseline: false,
      httpStatus,
      itemCount: 0,
      newItems: [],
      changedItems: [],
      unchangedCount: 0,
      error,
      durationMs: finished.getTime() - started.getTime(),
    };
  };

  const url = new URL(config.feedUrl);
  const allowed = url.hostname === config.publicationHost || (config.fixtureHost !== undefined && url.hostname === config.fixtureHost);
  if (!allowed || (url.protocol !== "https:" && url.hostname !== config.fixtureHost)) return fail("feed-url-not-allowed");

  let xml: string;
  try {
    const res = await (config.fetch ?? fetch)(url, {
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs ?? 20_000),
      headers: { accept: "application/rss+xml, application/xml;q=0.9" },
    });
    httpStatus = res.status;
    if (!res.ok) return fail(`feed-http-${res.status}`);
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) return fail("feed-too-large");
    // Enforce the limit while streaming, so a chunked response cannot be buffered without bound.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          return fail("feed-too-large");
        }
        chunks.push(value);
      }
    }
    xml = new TextDecoder().decode(Buffer.concat(chunks));
  } catch (e) {
    return fail(e instanceof Error && e.name === "TimeoutError" ? "feed-timeout" : "feed-unavailable");
  }

  let items: FeedItem[];
  try {
    items = parseFeed(xml, config.publicationHost);
  } catch (e) {
    return fail(e instanceof FeedError ? e.code : "invalid-feed");
  }
  const finished = now();
  const { baseline, added, changed } = await store.recordObservation(items, {
    pollId,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    httpStatus,
    itemCount: items.length,
  });
  return {
    pollId,
    outcome: "ok",
    baseline,
    httpStatus,
    itemCount: items.length,
    newItems: added,
    changedItems: changed,
    unchangedCount: items.length - added.length - changed.length,
    error: null,
    durationMs: finished.getTime() - started.getTime(),
  };
}

export { FeedError };
