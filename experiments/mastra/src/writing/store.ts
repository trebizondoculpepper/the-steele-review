import { createClient, type Client } from "@libsql/client";

/**
 * Writing attempts and their saved articles (#921). This narrow typed owner
 * keeps them in a dedicated LibSQL database on persistent storage. No other
 * module issues SQL against it.
 *
 * Attempt status:
 * - pending: created, pinned to one source version.
 * - calling: model call started; recorded before the request is sent.
 * - model-done: raw model output and usage saved; a retry reuses them and never pays again.
 * - saved: validated article saved.
 * - failed: stopped, with a stopping reason; the source and attempt context are kept.
 *
 * Saved articles are immutable: database triggers refuse update and delete.
 */

export type AttemptStatus = "pending" | "calling" | "model-done" | "saved" | "failed";

export interface Attempt {
  attempt: string;
  sourceVersion: string;
  mode: "fake" | "live";
  status: AttemptStatus;
  promptIdentity: string;
  model: string | null;
  rawOutput: string | null;
  usage: Record<string, unknown> | null;
  costUsd: number | null;
  finishReason: string | null;
  error: string | null;
  articleId: string | null;
  createdAt: string;
  updatedAt: string;
  modelStartedAt: string | null;
  modelFinishedAt: string | null;
}

export interface SavedArticle {
  articleId: string;
  attempt: string;
  sourceVersion: string;
  title: string;
  subtitle: string | null;
  markdown: string;
  articleJson: string;
  promptIdentity: string;
  model: string;
  createdAt: string;
}

export class AttemptStore {
  private readonly url: string;
  private client: Client | undefined;
  private ready: Promise<void> | undefined;

  constructor(url: string) {
    this.url = url;
  }

  private get db(): Client {
    this.client ??= createClient({ url: this.url });
    return this.client;
  }

  private init() {
    this.ready ??= Promise.resolve()
      .then(() =>
        this.db.batch(
          [
            `CREATE TABLE IF NOT EXISTS attempts (
              attempt TEXT PRIMARY KEY, source_version TEXT NOT NULL, mode TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('pending','calling','model-done','saved','failed')),
              prompt_identity TEXT NOT NULL, model TEXT, raw_output TEXT, usage TEXT, cost_usd REAL, finish_reason TEXT,
              error TEXT, article_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              model_started_at TEXT, model_finished_at TEXT)`,
            `CREATE TABLE IF NOT EXISTS articles (
              article_id TEXT PRIMARY KEY, attempt TEXT NOT NULL UNIQUE, source_version TEXT NOT NULL,
              title TEXT NOT NULL, subtitle TEXT, markdown TEXT NOT NULL, article_json TEXT NOT NULL,
              prompt_identity TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL)`,
            `CREATE TRIGGER IF NOT EXISTS articles_immutable BEFORE UPDATE ON articles BEGIN SELECT RAISE(ABORT, 'articles are immutable'); END`,
            `CREATE TRIGGER IF NOT EXISTS articles_no_delete BEFORE DELETE ON articles BEGIN SELECT RAISE(ABORT, 'articles are immutable'); END`,
          ],
          "write",
        ),
      )
      .then(() => undefined)
      .catch((e) => {
        this.ready = undefined;
        this.client?.close();
        this.client = undefined;
        throw e;
      });
    return this.ready;
  }

  async create(a: { attempt: string; sourceVersion: string; mode: "fake" | "live"; promptIdentity: string }, now: string) {
    await this.init();
    await this.db.execute({
      sql: `INSERT INTO attempts (attempt, source_version, mode, status, prompt_identity, created_at, updated_at) VALUES (?,?,?,'pending',?,?,?)`,
      args: [a.attempt, a.sourceVersion, a.mode, a.promptIdentity, now, now],
    });
  }

  async get(attempt: string): Promise<Attempt | undefined> {
    await this.init();
    const row = (await this.db.execute({ sql: "SELECT * FROM attempts WHERE attempt = ?", args: [attempt] })).rows[0];
    return row ? toAttempt(row) : undefined;
  }

  /** Durably records that a model call is about to be sent. Returns false if one was already started. */
  async beginModelCall(attempt: string, now: string): Promise<boolean> {
    await this.init();
    const r = await this.db.execute({
      sql: "UPDATE attempts SET status = 'calling', model_started_at = ?, updated_at = ? WHERE attempt = ? AND status = 'pending' AND model_started_at IS NULL",
      args: [now, now, attempt],
    });
    return r.rowsAffected === 1;
  }

  async saveModelOutput(
    attempt: string,
    out: { model: string; raw: string; usage: Record<string, unknown>; costUsd: number | null; finishReason: string | null },
    now: string,
  ) {
    await this.init();
    await this.db.execute({
      sql: `UPDATE attempts SET status = 'model-done', model = ?, raw_output = ?, usage = ?, cost_usd = ?, finish_reason = ?, model_finished_at = ?, updated_at = ?
            WHERE attempt = ? AND status = 'calling'`,
      args: [out.model, out.raw, JSON.stringify(out.usage), out.costUsd, out.finishReason, now, now, attempt],
    });
  }

  async fail(attempt: string, error: string, now: string) {
    await this.init();
    await this.db.execute({
      sql: "UPDATE attempts SET status = 'failed', error = ?, updated_at = ? WHERE attempt = ? AND status != 'saved'",
      args: [error, now, attempt],
    });
  }

  /** Saves the validated article and marks the attempt saved, atomically. */
  async saveArticle(a: Omit<SavedArticle, "createdAt">, now: string) {
    await this.init();
    const tx = await this.db.transaction("write");
    try {
      await tx.execute({
        sql: `INSERT INTO articles (article_id, attempt, source_version, title, subtitle, markdown, article_json, prompt_identity, model, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(article_id) DO NOTHING`,
        args: [a.articleId, a.attempt, a.sourceVersion, a.title, a.subtitle, a.markdown, a.articleJson, a.promptIdentity, a.model, now],
      });
      await tx.execute({
        sql: "UPDATE attempts SET status = 'saved', article_id = ?, error = NULL, updated_at = ? WHERE attempt = ?",
        args: [a.articleId, now, a.attempt],
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  async article(articleId: string): Promise<SavedArticle | undefined> {
    await this.init();
    const row = (await this.db.execute({ sql: "SELECT * FROM articles WHERE article_id = ?", args: [articleId] })).rows[0];
    if (!row) return undefined;
    return {
      articleId: String(row.article_id),
      attempt: String(row.attempt),
      sourceVersion: String(row.source_version),
      title: String(row.title),
      subtitle: (row.subtitle as string | null) ?? null,
      markdown: String(row.markdown),
      articleJson: String(row.article_json),
      promptIdentity: String(row.prompt_identity),
      model: String(row.model),
      createdAt: String(row.created_at),
    };
  }

  async list(limit: number): Promise<Attempt[]> {
    await this.init();
    const r = await this.db.execute({
      sql: "SELECT * FROM attempts ORDER BY created_at DESC LIMIT ?",
      args: [Math.min(Math.max(Math.trunc(limit) || 20, 1), 100)],
    });
    return r.rows.map(toAttempt);
  }

  /** Live spend so far: started live calls (charged or possibly charged) and their reported cost. */
  async liveLedger(): Promise<{ liveCallsStarted: number; reportedCostUsd: number }> {
    await this.init();
    const row = (
      await this.db.execute("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost FROM attempts WHERE mode = 'live' AND model_started_at IS NOT NULL")
    ).rows[0];
    return { liveCallsStarted: Number(row?.n ?? 0), reportedCostUsd: Number(row?.cost ?? 0) };
  }

  close() {
    this.client?.close();
    this.client = undefined;
  }
}

function toAttempt(row: Record<string, unknown>): Attempt {
  return {
    attempt: String(row.attempt),
    sourceVersion: String(row.source_version),
    mode: row.mode as "fake" | "live",
    status: row.status as AttemptStatus,
    promptIdentity: String(row.prompt_identity),
    model: (row.model as string | null) ?? null,
    rawOutput: (row.raw_output as string | null) ?? null,
    usage: row.usage ? JSON.parse(String(row.usage)) : null,
    costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
    finishReason: (row.finish_reason as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    articleId: (row.article_id as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    modelStartedAt: (row.model_started_at as string | null) ?? null,
    modelFinishedAt: (row.model_finished_at as string | null) ?? null,
  };
}
