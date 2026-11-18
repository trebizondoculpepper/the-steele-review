import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * SQLite operation claims and pending event records for processing stages.
 *
 * - A conditional claim gives one owner a lease on a stable operation key.
 *   Completed work is reused; an expired lease can be claimed again; attempts
 *   are bounded.
 * - Completion and the pending downstream events are recorded in one SQLite
 *   transaction, after the caller has committed its artifact. Events are then
 *   published separately and marked sent: SQLite and NATS never share a
 *   transaction, so a crash between them leaves a pending event to retry.
 *
 * All mutations use BEGIN IMMEDIATE, so concurrent processes serialise on the
 * database write lock (bounded by busy_timeout). WAL mode lets readers
 * proceed during writes. Errors carry codes only: no paths or payloads.
 */

export const SCHEMA_VERSION = 1;

export interface OperationStoreConfig {
  /** Absolute path of the SQLite file on a local persistent volume (runtime configuration). */
  path: string;
  /** Maximum wait for the write lock under contention, in ms. */
  busyTimeoutMs?: number;
  now?: () => number;
}

/** Handle for one claim attempt; the attempt number fences out stale holders. */
export interface OperationClaim {
  key: string;
  owner: string;
  attempt: number;
}

export type ClaimResult =
  | { kind: "claimed"; attempt: number; leaseExpiresAt: number; claim: OperationClaim }
  | { kind: "completed"; artifact: unknown }
  | { kind: "busy"; leaseExpiresAt: number }
  | { kind: "exhausted"; errorCode?: string };

export interface PendingEventInput {
  /** Stable event identity; the same ID is reused on every publication retry. */
  eventId: string;
  subject: string;
  /** Serialised event (structured JSON). */
  payload: string;
}

export interface PendingEvent extends PendingEventInput {
  operationKey: string;
  attempts: number;
}

export type OperationStoreErrorCode =
  | "invalid-config"
  | "invalid-input"
  | "not-owner"
  | "busy"
  | "unsupported-schema"
  | "event-conflict";

export class OperationStoreError extends Error {
  constructor(readonly code: OperationStoreErrorCode) {
    super(`operation store ${code}`);
    this.name = "OperationStoreError";
  }
}

const Key = z.string().min(1).max(512);
const Owner = z.string().min(1).max(200);
const Positive = z.number().int().positive();

const MIGRATION_V1 = `
CREATE TABLE IF NOT EXISTS operations (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'released', 'completed', 'failed')),
  owner TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  artifact TEXT,
  error_code TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_events (
  event_id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL REFERENCES operations(key),
  subject TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS pending_events_due ON pending_events (status, next_attempt_at);
`;

interface OperationRow {
  status: string;
  owner: string | null;
  lease_expires_at: number | null;
  attempts: number;
  max_attempts: number;
  artifact: string | null;
  error_code: string | null;
}

export class OperationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(config: OperationStoreConfig) {
    if (!isAbsolute(config.path)) throw new OperationStoreError("invalid-config");
    const busy = config.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(busy) || busy < 0 || busy > 60_000) {
      throw new OperationStoreError("invalid-config");
    }
    this.now = config.now ?? Date.now;
    try {
      this.db = new DatabaseSync(config.path, { timeout: busy });
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    } catch {
      throw new OperationStoreError("invalid-config");
    }
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version > SCHEMA_VERSION) throw new OperationStoreError("unsupported-schema");
    if (version < 1) {
      this.transaction(() => {
        this.db.exec(MIGRATION_V1);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
  }

  private transaction<T>(work: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      throw new OperationStoreError("busy");
    }
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private row(key: string): OperationRow | undefined {
    return this.db
      .prepare(
        "SELECT status, owner, lease_expires_at, attempts, max_attempts, artifact, error_code FROM operations WHERE key = ?",
      )
      .get(key) as OperationRow | undefined;
  }

  /** True when the row is still held by exactly this claim attempt. */
  private holds(row: OperationRow | undefined, claim: OperationClaim): boolean {
    return (
      row !== undefined &&
      row.status === "claimed" &&
      row.owner === claim.owner &&
      row.attempts === claim.attempt
    );
  }

  /** Atomically claim an operation, or report why it cannot be claimed. */
  claim(key: string, owner: string, leaseMs: number, maxAttempts = 5): ClaimResult {
    if (
      !Key.safeParse(key).success ||
      !Owner.safeParse(owner).success ||
      !Positive.safeParse(leaseMs).success ||
      !Positive.safeParse(maxAttempts).success
    ) {
      throw new OperationStoreError("invalid-input");
    }
    return this.transaction<ClaimResult>(() => {
      const now = this.now();
      const leaseExpiresAt = now + leaseMs;
      const row = this.row(key);
      if (!row) {
        this.db
          .prepare(
            "INSERT INTO operations (key, status, owner, lease_expires_at, attempts, max_attempts, updated_at) VALUES (?, 'claimed', ?, ?, 1, ?, ?)",
          )
          .run(key, owner, leaseExpiresAt, maxAttempts, now);
        return { kind: "claimed", attempt: 1, leaseExpiresAt, claim: { key, owner, attempt: 1 } };
      }
      if (row.status === "completed") {
        return { kind: "completed", artifact: JSON.parse(row.artifact ?? "null") };
      }
      if (row.status === "failed") {
        return { kind: "exhausted", errorCode: row.error_code ?? undefined };
      }
      if (row.status === "claimed" && (row.lease_expires_at ?? 0) > now) {
        return { kind: "busy", leaseExpiresAt: row.lease_expires_at ?? now };
      }
      if (row.attempts >= row.max_attempts) {
        this.db
          .prepare(
            "UPDATE operations SET status = 'failed', owner = NULL, lease_expires_at = NULL, error_code = COALESCE(error_code, 'attempts-exhausted'), updated_at = ? WHERE key = ?",
          )
          .run(now, key);
        return { kind: "exhausted", errorCode: row.error_code ?? "attempts-exhausted" };
      }
      const attempt = row.attempts + 1;
      this.db
        .prepare(
          "UPDATE operations SET status = 'claimed', owner = ?, lease_expires_at = ?, attempts = ?, updated_at = ? WHERE key = ?",
        )
        .run(owner, leaseExpiresAt, attempt, now, key);
      return { kind: "claimed", attempt, leaseExpiresAt, claim: { key, owner, attempt } };
    });
  }

  /** Extend a held lease. Throws not-owner if the lease was lost. */
  renew(claim: OperationClaim, leaseMs: number): number {
    const { key } = claim;
    return this.transaction(() => {
      const now = this.now();
      const row = this.row(key);
      if (!this.holds(row, claim)) {
        throw new OperationStoreError("not-owner");
      }
      const expires = now + leaseMs;
      this.db
        .prepare("UPDATE operations SET lease_expires_at = ?, updated_at = ? WHERE key = ?")
        .run(expires, now, key);
      return expires;
    });
  }

  /**
   * Record completion and pending downstream events in one transaction.
   * Call only after the artifact is durably committed. A repeated completion
   * with the same event IDs is a no-op returning the stored artifact.
   */
  complete(claim: OperationClaim, artifact: unknown, events: PendingEventInput[]): unknown {
    const { key } = claim;
    for (const event of events) {
      if (!event.eventId || !event.subject || typeof event.payload !== "string") {
        throw new OperationStoreError("invalid-input");
      }
    }
    return this.transaction(() => {
      const now = this.now();
      const row = this.row(key);
      if (row?.status === "completed") return JSON.parse(row.artifact ?? "null");
      if (!this.holds(row, claim)) {
        throw new OperationStoreError("not-owner");
      }
      this.db
        .prepare(
          "UPDATE operations SET status = 'completed', owner = NULL, lease_expires_at = NULL, artifact = ?, error_code = NULL, updated_at = ? WHERE key = ?",
        )
        .run(JSON.stringify(artifact), now, key);
      this.insertEvents(key, events, now);
      return artifact;
    });
  }

  /** Insert pending events for an operation; an identical existing record is accepted. */
  private insertEvents(key: string, events: PendingEventInput[], now: number): void {
    const existing = this.db.prepare(
      "SELECT operation_key, subject, payload FROM pending_events WHERE event_id = ?",
    );
    const insert = this.db.prepare(
      "INSERT INTO pending_events (event_id, operation_key, subject, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    );
    for (const event of events) {
      const found = existing.get(event.eventId) as
        | { operation_key: string; subject: string; payload: string }
        | undefined;
      if (found) {
        // Same record already present: fine. Anything else would drop downstream work.
        if (
          found.operation_key !== key ||
          found.subject !== event.subject ||
          found.payload !== event.payload
        ) {
          throw new OperationStoreError("event-conflict");
        }
        continue;
      }
      insert.run(event.eventId, key, event.subject, event.payload, now, now);
    }
  }

  /**
   * Record completion for an operation whose artifact is already durable but
   * whose completion was never recorded (the worker crashed after committing,
   * possibly on its final attempt). Refused while another owner holds a live
   * lease; a no-op returning the stored artifact if already completed.
   */
  reconcileCompleted(key: string, artifact: unknown, events: PendingEventInput[]): unknown {
    for (const event of events) {
      if (!event.eventId || !event.subject || typeof event.payload !== "string") {
        throw new OperationStoreError("invalid-input");
      }
    }
    return this.transaction(() => {
      const now = this.now();
      const row = this.row(key);
      if (row?.status === "completed") return JSON.parse(row.artifact ?? "null");
      if (row?.status === "claimed" && (row.lease_expires_at ?? 0) > now) {
        throw new OperationStoreError("busy");
      }
      if (row) {
        this.db
          .prepare(
            "UPDATE operations SET status = 'completed', owner = NULL, lease_expires_at = NULL, artifact = ?, error_code = NULL, updated_at = ? WHERE key = ?",
          )
          .run(JSON.stringify(artifact), now, key);
      } else {
        this.db
          .prepare(
            "INSERT INTO operations (key, status, attempts, max_attempts, artifact, updated_at) VALUES (?, 'completed', 0, 1, ?, ?)",
          )
          .run(key, JSON.stringify(artifact), now);
      }
      this.insertEvents(key, events, now);
      return artifact;
    });
  }

  /**
   * Release a held claim after a failed attempt. A retryable failure leaves
   * the operation claimable until attempts run out; a permanent one fails it.
   */
  fail(claim: OperationClaim, errorCode: string, retryable: boolean): void {
    const { key } = claim;
    this.transaction(() => {
      const now = this.now();
      const row = this.row(key);
      if (!this.holds(row, claim) || !row) {
        throw new OperationStoreError("not-owner");
      }
      const terminal = !retryable || row.attempts >= row.max_attempts;
      this.db
        .prepare(
          "UPDATE operations SET status = ?, owner = NULL, lease_expires_at = NULL, error_code = ?, updated_at = ? WHERE key = ?",
        )
        .run(terminal ? "failed" : "released", errorCode.slice(0, 100), now, key);
    });
  }

  /** Pending events due for (re)publication, oldest first. */
  duePendingEvents(limit = 100): PendingEvent[] {
    const rows = this.db
      .prepare(
        "SELECT event_id, operation_key, subject, payload, attempts FROM pending_events WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at, event_id LIMIT ?",
      )
      .all(this.now(), limit) as Array<{
      event_id: string;
      operation_key: string;
      subject: string;
      payload: string;
      attempts: number;
    }>;
    return rows.map((r) => ({
      eventId: r.event_id,
      operationKey: r.operation_key,
      subject: r.subject,
      payload: r.payload,
      attempts: r.attempts,
    }));
  }

  /** Mark an event acknowledged by the broker. Idempotent. */
  markEventSent(eventId: string): void {
    this.db
      .prepare(
        "UPDATE pending_events SET status = 'sent', sent_at = ? WHERE event_id = ? AND status = 'pending'",
      )
      .run(this.now(), eventId);
  }

  /** Record a failed publication attempt and schedule the next one. */
  markEventRetry(eventId: string, delayMs: number): void {
    const now = this.now();
    this.db
      .prepare(
        "UPDATE pending_events SET attempts = attempts + 1, next_attempt_at = ? WHERE event_id = ? AND status = 'pending'",
      )
      .run(now + Math.max(0, delayMs), eventId);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
