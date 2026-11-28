import type { ConfigReader } from "../common/config/index.js";
import { GitError, type GitRepository } from "../common/git/index.js";
import type { ChatModel } from "../common/model/openrouter.js";
import { CaptureError } from "../capture/substack.js";
import type { FeedRecord } from "../feed/substack-poller.js";
import { enabledSubstackFeeds } from "../feed/substack-sources.js";
import { fetchArticle, type ArticleRecord } from "./substack-article.js";

/**
 * The Git-backed raw-content collection (#953).
 *
 * One stable folder per item: `raw_content/<platform>/<source>/<item-id>/`.
 * `article.json` is the primary record (indexed as one document by #942);
 * the thumbnail, body images and the originals (`post.raw`,
 * `transcript.raw`) sit beside it and are committed with it in one commit.
 * Originals use a `.raw` extension so the indexer, which reads `*.json`,
 * never indexes them as separate documents.
 */

export const RAW_CONTENT = "raw_content";

export const RAW_CONTENT_DECLARATION = {
  mappingVersion: 1,
  mapping: {
    dynamic: "strict",
    properties: {
      schema: { type: "keyword" },
      platform: { type: "keyword" },
      sourceId: { type: "keyword" },
      itemId: { type: "keyword" },
      postId: { type: "keyword" },
      url: { type: "keyword" },
      canonicalUrl: { type: "keyword" },
      title: { type: "text" },
      subtitle: { type: "text" },
      publishedAt: { type: "date" },
      updatedAt: { type: "date" },
      medium: { type: "keyword" },
      representation: { type: "keyword" },
      feed: { type: "object", properties: { path: { type: "keyword" }, commit: { type: "keyword" } } },
      text: { type: "object", properties: { role: { type: "keyword" }, content: { type: "text" } } },
      transcript: {
        type: "object",
        properties: {
          status: { type: "keyword" },
          languageLabel: { type: "keyword" },
          content: { type: "text" },
          original: { type: "keyword", index: false },
          // The check's details are kept in the source but not indexed field by field.
          check: { type: "object", enabled: false },
        },
      },
      analysis: { type: "object", properties: { use: { type: "keyword" }, reason: { type: "keyword" } } },
      attribution: {
        type: "object",
        properties: {
          author: { type: "keyword" },
          authorId: { type: "keyword" },
          basis: { type: "keyword" },
          observedBylines: { type: "keyword" },
        },
      },
      thumbnail: { type: "object", enabled: false },
      images: { type: "object", enabled: false },
      original: { type: "object", enabled: false },
      warnings: { type: "keyword" },
    },
  },
} as const;

export function itemFolder(platform: string, sourceId: string, itemId: string): string {
  return `${RAW_CONTENT}/${platform}/${sourceId}/${itemId}`;
}

export interface FetchSummary {
  sourceId: string;
  itemId: string;
  status: "captured" | "unchanged" | "failed";
  /** Failure category, never a URL or response body. */
  error?: string;
  path?: string;
  commit?: string;
  analysis?: ArticleRecord["analysis"];
  transcript?: ArticleRecord["transcript"]["status"];
  images?: number;
  thumbnail?: boolean;
}

export interface FetchContentOptions {
  config: ConfigReader;
  repo: GitRepository;
  model: ChatModel;
  modelId?: string;
  branch?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface CommittedFeedRef {
  sourceId: string;
  itemId: string;
  path: string;
  change: "new" | "changed";
  commit: string;
}

/** Fetch and commit the raw content of each newly committed feed item. */
export async function fetchCommittedItems(refs: readonly CommittedFeedRef[], options: FetchContentOptions): Promise<FetchSummary[]> {
  const feeds = new Map((await enabledSubstackFeeds(options.config)).map((f) => [f.sourceId, f]));
  const branch = options.branch ?? "main";
  const summaries: FetchSummary[] = [];
  for (const ref of refs) {
    const summary: FetchSummary = { sourceId: ref.sourceId, itemId: ref.itemId, status: "failed" };
    summaries.push(summary);
    const feed = feeds.get(ref.sourceId);
    if (!feed) {
      summary.error = "source-not-enabled";
      continue;
    }
    try {
      // The exact committed feed record, never the working tree.
      const committed = await options.repo.readText(ref.commit, ref.path);
      if (!committed) {
        summary.error = "feed-record-missing";
        continue;
      }
      const feedRecord = JSON.parse(committed.text) as FeedRecord;
      if (feedRecord.sourceId !== ref.sourceId || feedRecord.itemId !== ref.itemId) {
        summary.error = "feed-record-mismatch";
        continue;
      }
      const folder = itemFolder("substack", ref.sourceId, ref.itemId);
      const head = await options.repo.resolve(`refs/heads/${branch}`);
      const previousText = head ? await options.repo.readText(head, `${folder}/article.json`) : null;
      const previous = previousText ? (JSON.parse(previousText.text) as ArticleRecord) : null;

      const fetched = await fetchArticle({
        feed,
        feedRecord,
        feedRef: { path: ref.path, commit: ref.commit },
        model: options.model,
        modelId: options.modelId,
        previous,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      });
      const declaration = `${RAW_CONTENT}/collection.json`;
      const writes = [
        { path: `${folder}/article.json`, content: `${JSON.stringify(fetched.record, null, 2)}\n` },
        ...fetched.assets.map((a) => ({ path: `${folder}/${a.file}`, content: a.content })),
      ];
      if (!head || !(await options.repo.readText(head, declaration)))
        writes.push({ path: declaration, content: `${JSON.stringify(RAW_CONTENT_DECLARATION, null, 2)}\n` });
      const result = await commitWithRetry(options.repo, branch, head, writes, `Capture ${ref.sourceId}/${ref.itemId}`);
      Object.assign(summary, {
        status: result.changed ? "captured" : "unchanged",
        path: `${folder}/article.json`,
        commit: result.commit ?? undefined,
        analysis: fetched.record.analysis,
        transcript: fetched.record.transcript.status,
        images: fetched.record.images.length,
        thumbnail: Boolean(fetched.record.thumbnail),
      });
    } catch (error) {
      summary.error =
        error instanceof CaptureError ? error.code : error instanceof GitError ? `git-${error.code}` : error instanceof SyntaxError ? "feed-record-invalid" : "fetch-failed";
    }
  }
  return summaries;
}

async function commitWithRetry(
  repo: GitRepository,
  branch: string,
  head: string | null,
  writes: Array<{ path: string; content: string | Buffer }>,
  message: string,
) {
  let parent = head;
  for (let attempt = 1; ; attempt++) {
    try {
      return await repo.commit({ branch, parent, writes, message });
    } catch (error) {
      // Another writer moved the branch; the item's files are independent, so commit on the new head.
      if (error instanceof GitError && error.code === "conflict" && attempt < 3) {
        parent = await repo.resolve(`refs/heads/${branch}`);
        continue;
      }
      throw error;
    }
  }
}
