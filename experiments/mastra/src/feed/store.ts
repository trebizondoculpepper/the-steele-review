import { createClient, type Client } from "@libsql/client";
import type { FeedItem } from "./rss.js";

/**
 * Durable discovery state (#919): which feed items have been seen, when, and
 * what each poll observed. Mastra keeps workflow runs and traces, but it has
 * no store for application records that must outlive run-history pruning, so
 * this narrow typed owner keeps them in its own LibSQL database. No other
 * module issues SQL against it.
 *
 * Item status:
 * - baseline: present when the subscription was activated; never submitted automatically.
 * - new: first seen after activation; awaiting capture (#920). This durable
 *   status, not a poll run's output, is the hand-off to capture: an item
 *   recorded here survives even if the process stops before Mastra saves
 *   the poll step's result.
 * - selected: entered manually by an operator.
 */

export type ItemStatus = "baseline" | "new" | "selected";

export interface StoredItem extends FeedItem {
  status: ItemStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  changeCount: number;
}

export interface PollRecord {
  pollId: string;
  startedAt: string;
  finishedAt: string;
  outcome: "ok" | "failed";
  httpStatus: number | null;
  itemCount: number;
  newCount: number;
  changedCount: number;
  baseline: boolean;
  error: string | null;
}

export class FeedStore {
  private readonly url: string;
  private client: Client | undefined;
  private ready: Promise<void> | undefined;

  constructor(url: string) {
    this.url = url;
  }

  /** The connection, opened lazily so a failure surfaces at use and can be retried. */
  private get db(): Client {
    this.client ??= createClient({ url: this.url });
    return this.client;
  }

  private init() {
    this.ready ??= Promise.resolve()
      .then(() =>
        this.db.batch(
        [
          `CREATE TABLE IF NOT EXISTS feed_items (
            canonical_url TEXT PRIMARY KEY, slug TEXT NOT NULL, post_id TEXT, source_item TEXT,
            title TEXT NOT NULL, published_at TEXT, medium TEXT NOT NULL, fingerprint TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('baseline','new','selected')),
            first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, change_count INTEGER NOT NULL DEFAULT 0)`,
          `CREATE TABLE IF NOT EXISTS feed_polls (
            poll_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
            outcome TEXT NOT NULL, http_status INTEGER, item_count INTEGER NOT NULL,
            new_count INTEGER NOT NULL, changed_count INTEGER NOT NULL, baseline INTEGER NOT NULL, error TEXT)`,
        ],
          "write",
        ),
      )
      .then(() => undefined)
      .catch((e) => {
        // Allow a later call to retry after a transient failure.
        this.ready = undefined;
        this.client?.close();
        this.client = undefined;
        throw e;
      });
    return this.ready;
  }

  async activated(): Promise<boolean> {
    await this.init();
    const r = await this.db.execute("SELECT 1 FROM feed_polls WHERE outcome = 'ok' LIMIT 1");
    return r.rows.length > 0;
  }

  /**
   * Records one successful observation atomically. Returns the items that are
   * new since activation and those whose metadata changed.
   */
  async recordObservation(items: FeedItem[], poll: Omit<PollRecord, "newCount" | "changedCount" | "baseline" | "outcome" | "error">) {
    await this.init();
    const tx = await this.db.transaction("write");
    try {
      const baseline = (await tx.execute("SELECT 1 FROM feed_polls WHERE outcome = 'ok' LIMIT 1")).rows.length === 0;
      const added: FeedItem[] = [];
      const changed: FeedItem[] = [];
      for (const it of items) {
        const prev = (await tx.execute({ sql: "SELECT fingerprint FROM feed_items WHERE canonical_url = ?", args: [it.canonicalUrl] })).rows[0];
        if (!prev) {
          await tx.execute({
            sql: `INSERT INTO feed_items (canonical_url, slug, post_id, source_item, title, published_at, medium, fingerprint, status, first_seen_at, last_seen_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            args: [it.canonicalUrl, it.slug, it.postId, it.sourceItem, it.title, it.publishedAt, it.medium, it.fingerprint, baseline ? "baseline" : "new", poll.finishedAt, poll.finishedAt],
          });
          if (!baseline) added.push(it);
        } else if (prev.fingerprint === "manual" || (baseline && prev.fingerprint !== it.fingerprint)) {
          // A manually selected placeholder, or any row met during activation:
          // fill in the observed metadata without reporting an edit.
          await tx.execute({
            sql: `UPDATE feed_items SET post_id = COALESCE(?, post_id), source_item = COALESCE(?, source_item), title = ?, published_at = ?, medium = ?,
                  fingerprint = ?, last_seen_at = ? WHERE canonical_url = ?`,
            args: [it.postId, it.sourceItem, it.title, it.publishedAt, it.medium, it.fingerprint, poll.finishedAt, it.canonicalUrl],
          });
        } else if (prev.fingerprint !== it.fingerprint) {
          await tx.execute({
            sql: `UPDATE feed_items SET post_id = COALESCE(?, post_id), source_item = COALESCE(?, source_item), title = ?, published_at = ?, medium = ?,
                  fingerprint = ?, last_seen_at = ?, change_count = change_count + 1 WHERE canonical_url = ?`,
            args: [it.postId, it.sourceItem, it.title, it.publishedAt, it.medium, it.fingerprint, poll.finishedAt, it.canonicalUrl],
          });
          changed.push(it);
        } else {
          await tx.execute({ sql: "UPDATE feed_items SET last_seen_at = ? WHERE canonical_url = ?", args: [poll.finishedAt, it.canonicalUrl] });
        }
      }
      await tx.execute({
        sql: `INSERT INTO feed_polls (poll_id, started_at, finished_at, outcome, http_status, item_count, new_count, changed_count, baseline, error)
              VALUES (?,?,?,'ok',?,?,?,?,?,NULL)`,
        args: [poll.pollId, poll.startedAt, poll.finishedAt, poll.httpStatus, poll.itemCount, added.length, changed.length, baseline ? 1 : 0],
      });
      await tx.commit();
      return { baseline, added, changed };
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  async recordFailure(poll: { pollId: string; startedAt: string; finishedAt: string; httpStatus: number | null; error: string }) {
    await this.init();
    await this.db.execute({
      sql: `INSERT INTO feed_polls (poll_id, started_at, finished_at, outcome, http_status, item_count, new_count, changed_count, baseline, error)
            VALUES (?,?,?,'failed',?,0,0,0,0,?)`,
      args: [poll.pollId, poll.startedAt, poll.finishedAt, poll.httpStatus, poll.error],
    });
  }

  /** Records an operator-selected item, or marks an existing one as selected. */
  async select(item: Pick<FeedItem, "canonicalUrl" | "slug">, now: string): Promise<{ created: boolean }> {
    await this.init();
    const tx = await this.db.transaction("write");
    try {
      const exists = (await tx.execute({ sql: "SELECT 1 FROM feed_items WHERE canonical_url = ?", args: [item.canonicalUrl] })).rows.length > 0;
      if (exists)
        await tx.execute({ sql: "UPDATE feed_items SET status = 'selected', last_seen_at = ? WHERE canonical_url = ?", args: [now, item.canonicalUrl] });
      else
        await tx.execute({
          sql: `INSERT INTO feed_items (canonical_url, slug, title, medium, fingerprint, status, first_seen_at, last_seen_at)
                VALUES (?, ?, '', 'unknown', 'manual', 'selected', ?, ?)`,
          args: [item.canonicalUrl, item.slug, now, now],
        });
      await tx.commit();
      return { created: !exists };
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  async items(limit: number, status?: ItemStatus): Promise<StoredItem[]> {
    await this.init();
    const bounded = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
    const r = await this.db.execute({
      sql: `SELECT * FROM feed_items ${status ? "WHERE status = ?" : ""} ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ?`,
      args: status ? [status, bounded] : [bounded],
    });
    return r.rows.map((row) => ({
      canonicalUrl: String(row.canonical_url),
      slug: String(row.slug),
      postId: (row.post_id as string | null) ?? null,
      sourceItem: (row.source_item as string | null) ?? null,
      title: String(row.title),
      publishedAt: (row.published_at as string | null) ?? null,
      medium: row.medium as FeedItem["medium"],
      fingerprint: String(row.fingerprint),
      status: row.status as ItemStatus,
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
      changeCount: Number(row.change_count),
    }));
  }

  async lastPolls(limit: number): Promise<PollRecord[]> {
    await this.init();
    const r = await this.db.execute({ sql: "SELECT * FROM feed_polls ORDER BY finished_at DESC LIMIT ?", args: [Math.min(Math.max(limit, 1), 50)] });
    return r.rows.map((row) => ({
      pollId: String(row.poll_id),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      outcome: row.outcome as "ok" | "failed",
      httpStatus: row.http_status === null ? null : Number(row.http_status),
      itemCount: Number(row.item_count),
      newCount: Number(row.new_count),
      changedCount: Number(row.changed_count),
      baseline: Number(row.baseline) === 1,
      error: (row.error as string | null) ?? null,
    }));
  }

  close() {
    this.client?.close();
    this.client = undefined;
  }
}
