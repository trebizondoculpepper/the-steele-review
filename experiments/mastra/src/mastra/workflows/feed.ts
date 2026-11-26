import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { pollFeed, feedConfigFromEnv } from "../../feed/poll.js";
import { canonicalPostUrl } from "../../feed/rss.js";
import { FeedStore } from "../../feed/store.js";

/**
 * Save Us Now RSS intake (#919), in Mastra's native workflow and scheduler.
 *
 * - `poll-feed` runs on Mastra's cron scheduler and on demand. The first
 *   successful poll records every current item as `baseline`, so the backlog
 *   is never submitted. Later polls report only new or changed items, and an
 *   unchanged feed changes nothing.
 * - `select-feed-item` is the separate manual path: an operator or agent
 *   enters one post URL from the allowed publication.
 * - `feed-status` is a read-only view of recent polls and discovered items.
 *
 * Discovery is kept separate from fetching posts (#920) and writing (#921).
 */

const store = new FeedStore(process.env.STEELE_EXP_MASTRA_FEED_DB ?? "file:./.data/feed.db");
export const FEED_POLL_CRON = process.env.STEELE_EXP_MASTRA_FEED_CRON ?? "*/30 * * * *";

const ItemSchema = z.object({
  canonicalUrl: z.string(),
  slug: z.string(),
  postId: z.string().nullable(),
  sourceItem: z.string().nullable(),
  title: z.string(),
  publishedAt: z.string().nullable(),
  medium: z.string(),
  fingerprint: z.string(),
});

const PollOutput = z.object({
  pollId: z.string(),
  baseline: z.boolean(),
  httpStatus: z.number().nullable(),
  itemCount: z.number(),
  newItems: z.array(ItemSchema),
  changedItems: z.array(ItemSchema),
  unchangedCount: z.number(),
  durationMs: z.number(),
});

const poll = createStep({
  id: "poll",
  description: "Fetch the feed once (read-only) and record new, changed and unchanged items.",
  inputSchema: z.object({}),
  outputSchema: PollOutput,
  execute: async () => {
    const r = await pollFeed(store, feedConfigFromEnv());
    // A failed poll is recorded, then raised so the run is visibly failed.
    if (r.outcome === "failed") throw new Error(`feed poll failed: ${r.error} (poll ${r.pollId})`);
    const { outcome: _o, error: _e, ...out } = r;
    return out;
  },
});

export const pollFeedWorkflow = createWorkflow({
  id: "poll-feed",
  description: "Save Us Now RSS discovery (#919): baseline on first poll, then new and changed items only.",
  inputSchema: z.object({}),
  outputSchema: PollOutput,
  schedule: { id: "save-us-now", cron: FEED_POLL_CRON, timezone: "UTC", inputData: {} },
})
  .then(poll)
  .commit();

const select = createStep({
  id: "select",
  description: "Record one operator-selected post URL from the allowed publication.",
  inputSchema: z.object({ url: z.string().max(500) }),
  outputSchema: z.object({ canonicalUrl: z.string(), slug: z.string(), created: z.boolean() }),
  execute: async ({ inputData }) => {
    const { publicationHost } = feedConfigFromEnv();
    const url = canonicalPostUrl(inputData.url, publicationHost);
    const slug = url.pathname.slice(3);
    const { created } = await store.select({ canonicalUrl: url.href, slug }, new Date().toISOString());
    return { canonicalUrl: url.href, slug, created };
  },
});

export const selectFeedItemWorkflow = createWorkflow({
  id: "select-feed-item",
  description: "Manually enter one post (#919), including an older one the baseline skipped.",
  inputSchema: select.inputSchema,
  outputSchema: select.outputSchema,
})
  .then(select)
  .commit();

const status = createStep({
  id: "status",
  description: "Read-only: recent polls and discovered items.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20), status: z.enum(["baseline", "new", "selected"]).optional() }),
  outputSchema: z.object({ polls: z.array(z.record(z.string(), z.unknown())), items: z.array(z.record(z.string(), z.unknown())) }),
  execute: async ({ inputData }) => ({
    polls: (await store.lastPolls(10)) as unknown as Record<string, unknown>[],
    items: (await store.items(inputData.limit, inputData.status)) as unknown as Record<string, unknown>[],
  }),
});

export const feedStatusWorkflow = createWorkflow({
  id: "feed-status",
  description: "Read-only view of the last polls and discovered items (#919).",
  inputSchema: status.inputSchema,
  outputSchema: status.outputSchema,
})
  .then(status)
  .commit();
