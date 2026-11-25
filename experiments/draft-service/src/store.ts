import { DatabaseSync } from "node:sqlite";

/**
 * Delivery intents and receipts (#912). This class is the only owner of the
 * SQLite database: no other module imports node:sqlite or issues SQL
 * (AGENTS.md, State ownership).
 *
 * States:
 * - pending: the intent is recorded, and a create may be in flight.
 * - created: the draft exists, and readback confirmed it is unpublished with no email.
 * - uncertain: a create may have happened, and reconciliation found no single matching draft.
 * - failed: the destination definitely did not create a draft. The same request may try again.
 */

export type DeliveryState = "pending" | "created" | "uncertain" | "failed";

export interface DeliveryRecord {
  requestId: string;
  payloadHash: string;
  platform: string;
  title: string;
  state: DeliveryState;
  draftId: string | null;
  destination: string;
  error: string | null;
  createAttempts: number;
  createdAt: string;
  updatedAt: string;
  receiptId: string | null;
}

export class DeliveryStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS deliveries (
        request_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        platform TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','created','uncertain','failed')),
        draft_id TEXT,
        destination TEXT NOT NULL,
        error TEXT,
        create_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        receipt_id TEXT
      );
    `);
  }

  get(requestId: string): DeliveryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE request_id = ?").get(requestId) as
      | Record<string, unknown>
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Records a new pending intent; returns false if the request ID already exists. */
  insertPending(r: { requestId: string; payloadHash: string; platform: string; title: string; destination: string }, now: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO deliveries (request_id, payload_hash, platform, title, state, destination, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(r.requestId, r.payloadHash, r.platform, r.title, r.destination, now, now);
    return result.changes === 1;
  }

  /** Marks the start of one create call. Must be durable before the call is sent. */
  beginCreate(requestId: string, now: string) {
    this.db
      .prepare("UPDATE deliveries SET state = 'pending', create_attempts = create_attempts + 1, error = NULL, updated_at = ? WHERE request_id = ?")
      .run(now, requestId);
  }

  markCreated(requestId: string, draftId: string, receiptId: string, now: string) {
    this.db
      .prepare("UPDATE deliveries SET state = 'created', draft_id = ?, receipt_id = ?, error = NULL, updated_at = ? WHERE request_id = ?")
      .run(draftId, receiptId, now, requestId);
  }

  mark(requestId: string, state: "uncertain" | "failed", error: string, now: string) {
    this.db.prepare("UPDATE deliveries SET state = ?, error = ?, updated_at = ? WHERE request_id = ?").run(state, error, now, requestId);
  }

  /** One platform's most recently updated deliveries; the platform filter applies before the limit. */
  list(platform: string, limit: number): DeliveryRecord[] {
    const bounded = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 20, 1), 100);
    return (
      this.db
        .prepare("SELECT * FROM deliveries WHERE platform = ? ORDER BY updated_at DESC LIMIT ?")
        .all(platform, bounded) as Record<string, unknown>[]
    ).map(toRecord);
  }

  ping(): boolean {
    return (this.db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
  }

  close() {
    this.db.close();
  }
}

function toRecord(r: Record<string, unknown>): DeliveryRecord {
  return {
    requestId: String(r.request_id),
    payloadHash: String(r.payload_hash),
    platform: String(r.platform),
    title: String(r.title),
    state: r.state as DeliveryState,
    draftId: (r.draft_id as string | null) ?? null,
    destination: String(r.destination),
    error: (r.error as string | null) ?? null,
    createAttempts: Number(r.create_attempts),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    receiptId: (r.receipt_id as string | null) ?? null,
  };
}
