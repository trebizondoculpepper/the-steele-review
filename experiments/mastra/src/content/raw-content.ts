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
  status: "captured" | "unchanged" | "failed" | "superseded";
  /** Failure category, never a URL or response body. */
  error?: string;
  path?: string;
  commit?: string;
  analysis?: ArticleRecord["analysis"];
  transcript?: ArticleRecord["transcript"]["status"];
  images?: number;
  thumbnail?: boolean;
  /** True when this item came from the retry queue rather than this poll. */
  retried?: boolean;
  /** Retry state when the capture is incomplete: retried by later runs until it succeeds or is exhausted. */
  pending?: { attempts: number; exhausted: boolean };
}

/**
 * Captures that did not complete (fetch failure or transcript-check failure)
 * leave a `capture.pending` marker in the item's folder. Every run retries
 * pending items as well as the newly committed ones, up to MAX_RETRIES_PER_RUN
 * per run and MAX_ATTEMPTS per item; the marker is removed when a capture
 * completes, and kept with `exhausted: true` after the last attempt. It has no
 * `.json` extension, so the indexer never indexes it.
 */
export const PENDING_FILE = "capture.pending";
export const MAX_ATTEMPTS = 5;
export const MAX_RETRIES_PER_RUN = 10;

interface PendingMarker {
  feedPath: string;
  attempts: number;
  exhausted: boolean;
  lastError: string;
}

class SupersededError extends Error {}

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

/** Items with an unexhausted retry marker, as references to their feed record at the branch head. */
async function pendingRefs(repo: GitRepository, branch: string, exclude: Set<string>): Promise<CommittedFeedRef[]> {
  const head = await repo.resolve(`refs/heads/${branch}`);
  if (!head) return [];
  const refs: CommittedFeedRef[] = [];
  let markers;
  try {
    markers = (await repo.listFiles(head, RAW_CONTENT)).filter((e) => e.path.endsWith(`/${PENDING_FILE}`));
  } catch {
    return [];
  }
  for (const entry of markers) {
    if (refs.length >= MAX_RETRIES_PER_RUN) break;
    const parts = entry.path.split("/"); // raw_content/substack/<source>/<item>/capture.pending
    const [, , sourceId, itemId] = parts;
    if (!sourceId || !itemId || exclude.has(`${sourceId}/${itemId}`)) continue;
    const marker = JSON.parse((await repo.readText(head, entry.path))!.text) as PendingMarker;
    if (marker.exhausted) continue;
    refs.push({ sourceId, itemId, path: marker.feedPath, change: "changed", commit: head });
  }
  return refs;
}

/**
 * Fetch and commit the raw content of each newly committed feed item, then
 * retry items whose earlier capture did not complete.
 */
export async function fetchCommittedItems(refs: readonly CommittedFeedRef[], options: FetchContentOptions): Promise<FetchSummary[]> {
  const feeds = new Map((await enabledSubstackFeeds(options.config)).map((f) => [f.sourceId, f]));
  const branch = options.branch ?? "main";
  const summaries: FetchSummary[] = [];
  const fresh = new Set(refs.map((r) => `${r.sourceId}/${r.itemId}`));
  const retries = await pendingRefs(options.repo, branch, fresh);
  for (const ref of [...refs, ...retries]) {
    const summary: FetchSummary = { sourceId: ref.sourceId, itemId: ref.itemId, status: "failed" };
    if (!fresh.has(`${ref.sourceId}/${ref.itemId}`)) summary.retried = true;
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
      // A transcript check that failed is retried by later runs; a completed capture clears the marker.
      const existingMarker = head ? await options.repo.readText(head, `${folder}/${PENDING_FILE}`) : null;
      const deletes: string[] = [];
      if (fetched.record.transcript.status === "check-failed") {
        const marker = nextMarker(existingMarker?.text, ref.path, "transcript-check-failed");
        writes.push({ path: `${folder}/${PENDING_FILE}`, content: `${JSON.stringify(marker)}\n` });
        summary.pending = { attempts: marker.attempts, exhausted: marker.exhausted };
      } else if (existingMarker) deletes.push(`${folder}/${PENDING_FILE}`);
      const result = await commitWithRetry(options.repo, branch, head, folder, writes, deletes, `Capture ${ref.sourceId}/${ref.itemId}`);
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
      if (error instanceof SupersededError) {
        summary.status = "superseded";
        continue;
      }
      summary.error =
        error instanceof CaptureError ? error.code : error instanceof GitError ? `git-${error.code}` : error instanceof SyntaxError ? "feed-record-invalid" : "fetch-failed";
      // Leave a retry marker so a later run captures the item (bounded attempts).
      await recordPending(options.repo, branch, ref, summary).catch(() => undefined);
    }
  }
  return summaries;
}

function nextMarker(existing: string | undefined, feedPath: string, error: string): PendingMarker {
  let attempts = 0;
  try {
    attempts = existing ? (JSON.parse(existing) as PendingMarker).attempts : 0;
  } catch {
    attempts = 0;
  }
  return { feedPath, attempts: attempts + 1, exhausted: attempts + 1 >= MAX_ATTEMPTS, lastError: error };
}

async function recordPending(repo: GitRepository, branch: string, ref: CommittedFeedRef, summary: FetchSummary) {
  const folder = itemFolder("substack", ref.sourceId, ref.itemId);
  const head = await repo.resolve(`refs/heads/${branch}`);
  const existing = head ? await repo.readText(head, `${folder}/${PENDING_FILE}`) : null;
  const marker = nextMarker(existing?.text, ref.path, summary.error ?? "fetch-failed");
  await commitWithRetry(repo, branch, head, null, [{ path: `${folder}/${PENDING_FILE}`, content: `${JSON.stringify(marker)}\n` }], [], `Retry pending ${ref.sourceId}/${ref.itemId}`);
  summary.pending = { attempts: marker.attempts, exhausted: marker.exhausted };
}

/**
 * Commit, and on a lost race retry on the new head only if this item's folder
 * did not change meanwhile: another run may have captured a newer revision of
 * the same item, which must never be replaced by this run's older content.
 */
async function commitWithRetry(
  repo: GitRepository,
  branch: string,
  head: string | null,
  folder: string | null,
  writes: Array<{ path: string; content: string | Buffer }>,
  deletes: string[],
  message: string,
) {
  let parent = head;
  for (let attempt = 1; ; attempt++) {
    try {
      return await repo.commit({ branch, parent, writes, deletes, message });
    } catch (error) {
      if (!(error instanceof GitError && error.code === "conflict") || attempt >= 3) throw error;
      const newer = await repo.resolve(`refs/heads/${branch}`);
      if (folder && newer && (parent ? (await repo.compare(parent, newer, folder)).length > 0 : (await repo.listFiles(newer, folder)).length > 0))
        throw new SupersededError();
      parent = newer;
    }
  }
}
