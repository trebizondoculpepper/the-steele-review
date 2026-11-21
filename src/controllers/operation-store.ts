import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";

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

export const SCHEMA_VERSION = 4;

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
  | {
      kind: "claimed";
      attempt: number;
      leaseExpiresAt: number;
      claim: OperationClaim;
    }
  | { kind: "completed"; artifact: unknown }
  | { kind: "busy"; leaseExpiresAt: number }
  | { kind: "exhausted"; errorCode?: string };

/** What the caller observed before asking to reopen a failed operation. */
export interface ReopenExpectation {
  errorCode: string;
  attempts: number;
}

export type ReopenResult =
  | { kind: "reopened"; attempts: number }
  /** The same retry was already recorded; its event is pending or sent. */
  | { kind: "already-reopened" }
  | { kind: "not-found" }
  | { kind: "completed" }
  | { kind: "busy" }
  /** Not failed, or failed with a different error code or attempt count. */
  | { kind: "mismatch"; status: string; errorCode?: string; attempts: number };

export type PublicationStatus =
  | "intent"
  | "draft-saved"
  | "uncertain"
  | "unpublished"
  | "published";

/** Identity of the exact artifact approved for publication. */
export interface PublicationArtifact {
  /** Content hash of the approved draft, e.g. sha256:<hex>. */
  hash: string;
  /** Immutable artifact reference (repository, commit, path, hash). */
  ref: unknown;
}

export interface PublicationReceipt {
  url: string;
  publishedAt: string;
  destinationPostId?: string;
}

export interface PublicationState {
  key: string;
  status: PublicationStatus;
  artifactHash: string;
  artifact: unknown;
  destinationDraftId?: string;
  receipt?: PublicationReceipt;
}

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
  | "event-conflict"
  | "artifact-mismatch"
  | "destination-conflict"
  | "invalid-transition";

export class OperationStoreError extends Error {
  constructor(readonly code: OperationStoreErrorCode) {
    super(`operation store ${code}`);
    this.name = "OperationStoreError";
  }
}

const Key = z.string().min(1).max(512);
const Owner = z.string().min(1).max(200);
const Positive = z.number().int().positive();

const MIGRATION_V2 = `
CREATE TABLE IF NOT EXISTS publications (
  key TEXT PRIMARY KEY REFERENCES operations(key),
  artifact_hash TEXT NOT NULL,
  artifact TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intent', 'draft-saved', 'uncertain', 'unpublished', 'published')),
  destination_draft_id TEXT,
  receipt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

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

/** #171: inspection counts events per operation; keep that lookup bounded. */
const MIGRATION_V3 = `
CREATE INDEX IF NOT EXISTS pending_events_by_operation ON pending_events (operation_key, status);
`;

/**
 * #447: the current manual editorial disposition for one exact draft identity.
 * A small ordered register, separate from immutable operation completion: the
 * newest decision by `decided_at` wins, and an older late arrival never
 * overwrites it.
 */
const MIGRATION_V4 = `
CREATE TABLE IF NOT EXISTS editorial_dispositions (
  key TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  order_key TEXT NOT NULL
);
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

/** Read-only operation state. */
export interface OperationStatus {
  key: string;
  status: "claimed" | "released" | "completed" | "failed";
  /** True when no further attempt will be granted. */
  exhausted: boolean;
  attempts: number;
  errorCode?: string;
  artifact?: unknown;
}

function toStatus(key: string, row: OperationRow): OperationStatus {
  return {
    key,
    status: row.status as OperationStatus["status"],
    exhausted: row.status === "failed",
    attempts: row.attempts,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.artifact !== null ? { artifact: JSON.parse(row.artifact) as unknown } : {}),
  };
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
        this.db.exec("PRAGMA user_version = 1");
      });
    }
    if (version < 2) {
      this.transaction(() => {
        this.db.exec(MIGRATION_V2);
        this.db.exec("PRAGMA user_version = 2");
      });
    }
    if (version < 3) {
      this.transaction(() => {
        this.db.exec(MIGRATION_V3);
        this.db.exec("PRAGMA user_version = 3");
      });
    }
    if (version < 4) {
      this.transaction(() => {
        this.db.exec(MIGRATION_V4);
        this.db.exec("PRAGMA user_version = 4");
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

  /**
   * Read-only view of one operation, for coordinators that must observe
   * progress without claiming work. Undefined when the key is unknown.
   */
  operationStatus(key: string): OperationStatus | undefined {
    const row = this.row(key);
    return row ? toStatus(key, row) : undefined;
  }

  /**
   * Read-only views of operations whose key starts with `prefix`, in key
   * order, bounded. Pass the last key seen as `after` to read the next page.
   */
  listOperations(prefix: string, limit = 100, after?: string): OperationStatus[] {
    if (!prefix) throw new OperationStoreError("invalid-input");
    const bound = Math.max(1, Math.min(Math.trunc(limit), 1_000));
    // Range scan rather than LIKE, so `%` and `_` in keys match literally.
    const rows = this.db
      .prepare(
        "SELECT key, status, owner, lease_expires_at, attempts, max_attempts, artifact, error_code FROM operations WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?",
      )
      .all(prefix, `${prefix}\uffff`, after ?? "", bound) as unknown as Array<
      OperationRow & { key: string }
    >;
    return rows.map((r) => toStatus(r.key, r));
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
        return {
          kind: "claimed",
          attempt: 1,
          leaseExpiresAt,
          claim: { key, owner, attempt: 1 },
        };
      }
      if (row.status === "completed") {
        return {
          kind: "completed",
          artifact: JSON.parse(row.artifact ?? "null"),
        };
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
        return {
          kind: "exhausted",
          errorCode: row.error_code ?? "attempts-exhausted",
        };
      }
      const attempt = row.attempts + 1;
      this.db
        .prepare(
          "UPDATE operations SET status = 'claimed', owner = ?, lease_expires_at = ?, attempts = ?, updated_at = ? WHERE key = ?",
        )
        .run(owner, leaseExpiresAt, attempt, now, key);
      return {
        kind: "claimed",
        attempt,
        leaseExpiresAt,
        claim: { key, owner, attempt },
      };
    });
  }

  /**
   * Claim a publication operation for reconciliation even if its attempts
   * are exhausted. Allowed only while a destination draft exists and the
   * outcome is unresolved (`draft-saved` or `uncertain`): an external side
   * effect may already have happened, so the state must be read back rather
   * than abandoned. A live lease held by another owner is still respected.
   */
  claimForReconciliation(key: string, owner: string, leaseMs: number): ClaimResult {
    if (
      !Key.safeParse(key).success ||
      !Owner.safeParse(owner).success ||
      !Positive.safeParse(leaseMs).success
    ) {
      throw new OperationStoreError("invalid-input");
    }
    return this.transaction<ClaimResult>(() => {
      const now = this.now();
      const row = this.row(key);
      const publication = this.publicationRow(key);
      // Reconcilable: an unresolved outcome, or a confirmed publication whose
      // operation never completed (crash between confirmation and handoff).
      const unresolved =
        publication?.status === "draft-saved" || publication?.status === "uncertain";
      const confirmedButOpen = publication?.status === "published" && row?.status !== "completed";
      if (!row || !publication?.destination_draft_id || (!unresolved && !confirmedButOpen)) {
        throw new OperationStoreError("invalid-transition");
      }
      if (row.status === "completed") {
        return {
          kind: "completed",
          artifact: JSON.parse(row.artifact ?? "null"),
        };
      }
      if (row.status === "claimed" && (row.lease_expires_at ?? 0) > now) {
        return { kind: "busy", leaseExpiresAt: row.lease_expires_at ?? now };
      }
      const attempt = row.attempts + 1;
      const leaseExpiresAt = now + leaseMs;
      this.db
        .prepare(
          "UPDATE operations SET status = 'claimed', owner = ?, lease_expires_at = ?, attempts = ?, updated_at = ? WHERE key = ?",
        )
        .run(owner, leaseExpiresAt, attempt, now, key);
      return {
        kind: "claimed",
        attempt,
        leaseExpiresAt,
        claim: { key, owner, attempt },
      };
    });
  }

  /**
   * Durably record a permanent, non-retryable outcome for an operation in a
   * single transaction, whether or not anyone holds a claim on it. A
   * completed operation is left untouched. Use for outcomes observed outside
   * a claim (for example a consumer giving up on a message), so the record
   * cannot be lost between separate claim and fail steps.
   */
  recordPermanentFailure(key: string, errorCode: string): void {
    if (!Key.safeParse(key).success || !errorCode) throw new OperationStoreError("invalid-input");
    this.transaction(() => {
      const now = this.now();
      const row = this.row(key);
      if (row?.status === "completed") return;
      if (row) {
        this.db
          .prepare(
            "UPDATE operations SET status = 'failed', owner = NULL, lease_expires_at = NULL, error_code = ?, updated_at = ? WHERE key = ?",
          )
          .run(errorCode.slice(0, 100), now, key);
      } else {
        this.db
          .prepare(
            "INSERT INTO operations (key, status, attempts, max_attempts, error_code, updated_at) VALUES (?, 'failed', 0, 1, ?, ?)",
          )
          .run(key, errorCode.slice(0, 100), now);
      }
    });
  }

  /**
   * Deliberately reopen one terminally failed operation for exactly one more
   * attempt, recording the redelivery event in the same transaction so the
   * retry intent cannot be lost between the two. Fenced on the caller's
   * observation: the row must still be failed with the expected error code
   * and attempt count. Completed, claimed or released work is never touched,
   * and attempt numbers stay monotonic. Repeating the same request (same
   * event ID) after it succeeded reports `already-reopened`.
   */
  reopenFailed(key: string, expected: ReopenExpectation, event: PendingEventInput): ReopenResult {
    if (
      !Key.safeParse(key).success ||
      !expected.errorCode ||
      !Number.isInteger(expected.attempts) ||
      expected.attempts < 0 ||
      !event.eventId ||
      !event.subject ||
      typeof event.payload !== "string"
    ) {
      throw new OperationStoreError("invalid-input");
    }
    return this.transaction<ReopenResult>(() => {
      const prior = this.db
        .prepare("SELECT operation_key FROM pending_events WHERE event_id = ?")
        .get(event.eventId) as { operation_key: string } | undefined;
      if (prior) {
        if (prior.operation_key !== key) throw new OperationStoreError("event-conflict");
        return { kind: "already-reopened" };
      }
      const row = this.row(key);
      if (!row) return { kind: "not-found" };
      if (row.status === "completed") return { kind: "completed" };
      if (row.status === "claimed") return { kind: "busy" };
      if (
        row.status !== "failed" ||
        row.error_code !== expected.errorCode ||
        row.attempts !== expected.attempts
      ) {
        return {
          kind: "mismatch",
          status: row.status,
          ...(row.error_code ? { errorCode: row.error_code } : {}),
          attempts: row.attempts,
        };
      }
      const now = this.now();
      this.db
        .prepare(
          "UPDATE operations SET status = 'released', owner = NULL, lease_expires_at = NULL, error_code = NULL, max_attempts = attempts + 1, updated_at = ? WHERE key = ?",
        )
        .run(now, key);
      this.insertEvents(key, [event], now);
      return { kind: "reopened", attempts: row.attempts };
    });
  }

  /**
   * Hand a claim back without counting it as a failed attempt, for work that
   * made progress and will continue on a later delivery. Fenced like other
   * transitions. Attempt numbers stay monotonic (they are the fencing token);
   * instead the attempt budget is extended by one, so continuations never
   * exhaust the failure budget.
   */
  yieldClaim(claim: OperationClaim): void {
    this.transaction(() => {
      const row = this.row(claim.key);
      if (!this.holds(row, claim)) throw new OperationStoreError("not-owner");
      this.db
        .prepare(
          "UPDATE operations SET status = 'released', owner = NULL, lease_expires_at = NULL, max_attempts = max_attempts + 1, updated_at = ? WHERE key = ?",
        )
        .run(this.now(), claim.key);
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
  duePendingEvents(limit = 100, subject?: string): PendingEvent[] {
    // Filter by subject in SQL so other subjects' backlog cannot crowd out the limit.
    const rows = (
      subject === undefined
        ? this.db
            .prepare(
              "SELECT event_id, operation_key, subject, payload, attempts FROM pending_events WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at, event_id LIMIT ?",
            )
            .all(this.now(), limit)
        : this.db
            .prepare(
              "SELECT event_id, operation_key, subject, payload, attempts FROM pending_events WHERE status = 'pending' AND next_attempt_at <= ? AND subject = ? ORDER BY created_at, event_id LIMIT ?",
            )
            .all(this.now(), subject, limit)
    ) as Array<{
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

  /**
   * One recorded event by its stable ID, whatever its due time or position in
   * the backlog, so callers never have to page the outbox to find it.
   */
  pendingEvent(eventId: string): PendingEvent | undefined {
    const row = this.db
      .prepare(
        "SELECT event_id, operation_key, subject, payload, attempts FROM pending_events WHERE event_id = ?",
      )
      .get(eventId) as
      | {
          event_id: string;
          operation_key: string;
          subject: string;
          payload: string;
          attempts: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      eventId: row.event_id,
      operationKey: row.operation_key,
      subject: row.subject,
      payload: row.payload,
      attempts: row.attempts,
    };
  }

  /**
   * Record the current manual editorial disposition for one exact draft
   * identity (#447). Ordered by the decision timestamp: an equal or newer
   * decision replaces the previous one atomically; an older one is ignored so
   * a late delivery cannot regress the disposition.
   */
  recordEditorialDisposition(input: {
    key: string;
    decision: unknown;
    decidedAt: string;
    /** Total-order tiebreak (for example the request ID) for equal timestamps. */
    order: string;
  }): { applied: boolean } {
    if (
      !Key.safeParse(input.key).success ||
      !/^\d{4}-\d{2}-\d{2}T/.test(input.decidedAt) ||
      !Key.safeParse(input.order).success
    ) {
      throw new OperationStoreError("invalid-input");
    }
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT decided_at, order_key FROM editorial_dispositions WHERE key = ?")
        .get(input.key) as { decided_at: string; order_key: string } | undefined;
      // Compare the (decided_at, order) pair as a total order: equal timestamps
      // still have a deterministic winner, so replaying an earlier decision
      // cannot overwrite a later one.
      if (
        existing &&
        (existing.decided_at > input.decidedAt ||
          (existing.decided_at === input.decidedAt && existing.order_key >= input.order))
      ) {
        return { applied: false };
      }
      this.db
        .prepare(
          "INSERT INTO editorial_dispositions (key, decision, decided_at, order_key) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at, order_key = excluded.order_key",
        )
        .run(input.key, JSON.stringify(input.decision), input.decidedAt, input.order);
      return { applied: true };
    });
  }

  /** Current editorial disposition for one exact draft identity, if any. */
  editorialDisposition(
    key: string,
  ): { decision: unknown; decidedAt: string; order: string } | undefined {
    const row = this.db
      .prepare("SELECT decision, decided_at, order_key FROM editorial_dispositions WHERE key = ?")
      .get(key) as { decision: string; decided_at: string; order_key: string } | undefined;
    if (!row) return undefined;
    return {
      decision: JSON.parse(row.decision) as unknown,
      decidedAt: row.decided_at,
      order: row.order_key,
    };
  }

  /** Delivery status of one recorded event, or undefined if none was recorded. */
  pendingEventStatus(eventId: string): "pending" | "sent" | undefined {
    const row = this.db
      .prepare("SELECT status FROM pending_events WHERE event_id = ?")
      .get(eventId) as { status: "pending" | "sent" } | undefined;
    return row?.status;
  }

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

  private publicationRow(key: string):
    | {
        status: PublicationStatus;
        artifact_hash: string;
        artifact: string;
        destination_draft_id: string | null;
        receipt: string | null;
      }
    | undefined {
    return this.db
      .prepare(
        "SELECT status, artifact_hash, artifact, destination_draft_id, receipt FROM publications WHERE key = ?",
      )
      .get(key) as never;
  }

  private toPublicationState(key: string): PublicationState | undefined {
    const row = this.publicationRow(key);
    if (!row) return undefined;
    return {
      key,
      status: row.status,
      artifactHash: row.artifact_hash,
      artifact: JSON.parse(row.artifact),
      ...(row.destination_draft_id ? { destinationDraftId: row.destination_draft_id } : {}),
      ...(row.receipt ? { receipt: JSON.parse(row.receipt) as PublicationReceipt } : {}),
    };
  }

  /** Run a publication transition for the current holder of the operation's claim. */
  private publicationTransition(
    claim: OperationClaim,
    work: (now: number) => void,
  ): PublicationState {
    return this.transaction(() => {
      if (!this.holds(this.row(claim.key), claim)) throw new OperationStoreError("not-owner");
      work(this.now());
      return this.toPublicationState(claim.key)!;
    });
  }

  /**
   * Persist publication intent for the exact approved artifact before any
   * external side effect. Repeating with the same artifact returns the stored
   * state (including any known destination draft); a different artifact is
   * refused.
   */
  recordPublicationIntent(claim: OperationClaim, artifact: PublicationArtifact): PublicationState {
    if (!artifact.hash || artifact.hash.length > 200) {
      throw new OperationStoreError("invalid-input");
    }
    return this.publicationTransition(claim, (now) => {
      const existing = this.publicationRow(claim.key);
      if (existing) {
        if (existing.artifact_hash !== artifact.hash) {
          throw new OperationStoreError("artifact-mismatch");
        }
        return;
      }
      this.db
        .prepare(
          "INSERT INTO publications (key, artifact_hash, artifact, status, created_at, updated_at) VALUES (?, ?, ?, 'intent', ?, ?)",
        )
        .run(claim.key, artifact.hash, JSON.stringify(artifact.ref ?? null), now, now);
    });
  }

  /**
   * Record the destination draft ID. Once known it is never replaced: the
   * same ID is a no-op and a different one is refused, so a retry reuses the
   * existing draft instead of creating another.
   */
  saveDestinationDraft(claim: OperationClaim, draftId: string): PublicationState {
    if (!draftId || draftId.length > 200) throw new OperationStoreError("invalid-input");
    return this.publicationTransition(claim, (now) => {
      const row = this.publicationRow(claim.key);
      if (!row) throw new OperationStoreError("invalid-transition");
      if (row.destination_draft_id) {
        if (row.destination_draft_id !== draftId) {
          throw new OperationStoreError("destination-conflict");
        }
        return;
      }
      if (row.status !== "intent") throw new OperationStoreError("invalid-transition");
      this.db
        .prepare(
          "UPDATE publications SET destination_draft_id = ?, status = 'draft-saved', updated_at = ? WHERE key = ?",
        )
        .run(draftId, now, claim.key);
    });
  }

  /** Record that a publish attempt's outcome is unknown (e.g. lost response). */
  markPublicationUncertain(claim: OperationClaim): PublicationState {
    return this.publicationTransition(claim, (now) => {
      const row = this.publicationRow(claim.key);
      if (!row?.destination_draft_id) throw new OperationStoreError("invalid-transition");
      if (row.status === "published" || row.status === "uncertain") return;
      this.db
        .prepare("UPDATE publications SET status = 'uncertain', updated_at = ? WHERE key = ?")
        .run(now, claim.key);
    });
  }

  /** Record that read-back established the draft is not published. */
  markPublicationUnpublished(claim: OperationClaim): PublicationState {
    return this.publicationTransition(claim, (now) => {
      const row = this.publicationRow(claim.key);
      if (!row?.destination_draft_id) throw new OperationStoreError("invalid-transition");
      if (row.status === "published") throw new OperationStoreError("invalid-transition");
      this.db
        .prepare("UPDATE publications SET status = 'unpublished', updated_at = ? WHERE key = ?")
        .run(now, claim.key);
    });
  }

  /**
   * Record a confirmed publication receipt. Repeating with the same receipt
   * is a no-op; a different receipt for a published item is refused.
   */
  confirmPublished(claim: OperationClaim, receipt: PublicationReceipt): PublicationState {
    if (!receipt.url || !receipt.publishedAt) throw new OperationStoreError("invalid-input");
    const serialised = JSON.stringify({
      url: receipt.url,
      publishedAt: receipt.publishedAt,
      ...(receipt.destinationPostId ? { destinationPostId: receipt.destinationPostId } : {}),
    });
    return this.publicationTransition(claim, (now) => {
      const row = this.publicationRow(claim.key);
      if (!row?.destination_draft_id) throw new OperationStoreError("invalid-transition");
      if (row.status === "published") {
        if (row.receipt !== serialised) throw new OperationStoreError("destination-conflict");
        return;
      }
      this.db
        .prepare(
          "UPDATE publications SET status = 'published', receipt = ?, updated_at = ? WHERE key = ?",
        )
        .run(serialised, now, claim.key);
    });
  }

  /** Read-only view of a publication's state. */
  publicationState(key: string): PublicationState | undefined {
    return this.toPublicationState(key);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

/**
 * Allowlisted snapshot of one operation, for diagnostics only (#171).
 *
 * Deliberately narrow: no owner, no raw payloads, no physical paths and no
 * generic query surface. The completion artifact is shown only when the stored
 * value is a valid immutable artifact reference; anything else stays hidden.
 */
export interface OperationInspection {
  key: string;
  status: OperationStatus["status"];
  /** True when no further attempt will be granted. */
  exhausted: boolean;
  attempts: number;
  maxAttempts: number;
  errorCode?: string;
  /** Lease expiry as an ISO 8601 timestamp, when a lease is held. */
  leaseExpiresAt?: string;
  /** Logical completion artifact evidence, when a known writer recorded one. */
  artifact?: OperationArtifact;
  pendingEvents: { pending: number; sent: number };
}

export interface OperationStatusCount {
  status: OperationStatus["status"];
  count: number;
}

export type OperationInspectorOpenResult =
  | { status: "available"; inspector: OperationInspector }
  | { status: "unavailable" };

interface InspectionRow {
  status: string;
  attempts: number;
  max_attempts: number;
  artifact: string | null;
  error_code: string | null;
  lease_expires_at: number | null;
  pending_count: number | null;
  sent_count: number | null;
}

/**
 * Logical completion evidence recorded by the existing stage writers.
 *
 * Writers store different shapes: the collection store a bare `ArtifactRef`
 * (`sha256` without a scheme), the claim worker `{ claimsArtifact }`, the
 * publisher `{ artifact }`, and the brief/verification stages only a partial
 * `{ path, commit }`. Normalise the recognised forms and never return any
 * other field: an unrecognised artifact may carry tokens or payload.
 */
export type OperationArtifact =
  | {
      kind: "reference";
      repository: string;
      commit: string;
      path: string;
      hash: string;
    }
  | { kind: "partial"; commit?: string; path?: string };

/** Raw `ArtifactRef` as stored by the collection controller (`sha256` bare). */
const StoredRefSchema = z
  .object({
    repository: ArtifactReferenceSchema.shape.repository,
    commit: ArtifactReferenceSchema.shape.commit,
    path: ArtifactReferenceSchema.shape.path,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Fields a partial writer may record; nothing else is exposed. */
const PartialSchema = z
  .object({
    commit: ArtifactReferenceSchema.shape.commit.optional(),
    path: ArtifactReferenceSchema.shape.path.optional(),
  })
  .strict();

const PathOnlySchema = ArtifactReferenceSchema.shape.path;

/** True when the object carries no key outside the allowlist. */
function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function asReference(value: unknown): OperationArtifact | undefined {
  const full = ArtifactReferenceSchema.safeParse(value);
  if (full.success) return { kind: "reference", ...full.data };
  const stored = StoredRefSchema.safeParse(value);
  if (stored.success) {
    // Re-validate as a logical reference: the repository is a logical name and
    // the path is relative, so a legacy absolute path, private URL or parent
    // traversal cannot reach diagnostics.
    const { repository, commit, path, sha256 } = stored.data;
    const normalised = ArtifactReferenceSchema.safeParse({
      repository,
      commit,
      path,
      hash: `sha256:${sha256}`,
    });
    if (normalised.success) return { kind: "reference", ...normalised.data };
  }
  return undefined;
}

/** Recognise a completion artifact without returning unlisted fields. */
export function logicalArtifact(value: unknown): OperationArtifact | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;

  const direct = asReference(value);
  if (direct) return direct;
  for (const key of ["artifact", "ref", "claimsArtifact"] as const) {
    const nested = asReference(record[key]);
    if (nested) return nested;
  }

  // Brief and historical-comparison writers record { path, commit }.
  if (onlyKeys(record, ["commit", "path"])) {
    const partial = PartialSchema.safeParse({
      ...(record.commit === undefined ? {} : { commit: record.commit }),
      ...(record.path === undefined ? {} : { path: record.path }),
    });
    if (partial.success && (partial.data.commit || partial.data.path)) {
      const { commit, path } = partial.data;
      return {
        kind: "partial",
        ...(commit === undefined ? {} : { commit }),
        ...(path === undefined ? {} : { path }),
      };
    }
  }

  // Verification records { report: <path>, verdict }; expose the path only.
  if (onlyKeys(record, ["report", "verdict"])) {
    const path = PathOnlySchema.safeParse(record.report);
    if (path.success) return { kind: "partial", path: path.data };
  }

  return undefined;
}

/**
 * The store changed after the inspector opened it, so a result can no longer be
 * trusted: an immutable connection that reads a moving file can return stale
 * rows or fail with a corruption error. Callers report the store as unavailable.
 * Deliberately carries no path, SQL or filesystem detail.
 */
export class OperationStoreChangedError extends Error {
  constructor() {
    super("operation store changed during inspection");
    this.name = "OperationStoreChangedError";
  }
}

/**
 * Identity of the database file at open: any write replaced or extended it.
 * `changeCounter` is SQLite's own header counter, which moves on every write
 * even when a filesystem timestamp has coarse resolution.
 */
interface StoreIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  changeCounter: number | undefined;
}

/** SQLite's 100-byte header; the change counter is the big-endian u32 at offset 24. */
function sqliteChangeCounter(path: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, 100, 0) < 28) return undefined;
    return header.readUInt32BE(24);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function storeIdentity(path: string): StoreIdentity | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    if (!stats.isFile()) return undefined;
    return {
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      changeCounter: sqliteChangeCounter(path),
    };
  } catch {
    return undefined;
  }
}

const COUNTS_SQL =
  "SELECT status, COUNT(*) AS count FROM operations GROUP BY status ORDER BY status";

/** One statement, one snapshot: the row and its event counts share a moment. */
const OPERATION_SQL = `SELECT o.status, o.attempts, o.max_attempts, o.artifact, o.error_code, o.lease_expires_at,
          (SELECT COUNT(*) FROM pending_events p WHERE p.operation_key = o.key AND p.status = 'pending') AS pending_count,
          (SELECT COUNT(*) FROM pending_events p WHERE p.operation_key = o.key AND p.status = 'sent') AS sent_count
     FROM operations o WHERE o.key = ?`;

const unchanged = (a: StoreIdentity, b: StoreIdentity | undefined): boolean =>
  b !== undefined &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.changeCounter === b.changeCounter;

export class OperationInspector {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly resolvedPath: string,
    /** Quiescent reads re-check the file; a WAL snapshot keeps its transaction. */
    private readonly mode: "quiescent" | "snapshot",
    private readonly identity: StoreIdentity | undefined,
    private readonly counts: StatementSync,
    private readonly operation: StatementSync,
  ) {}

  static open(
    path: string,
    options: { busyTimeoutMs?: number; now?: () => number } = {},
  ): OperationInspectorOpenResult {
    if (typeof path !== "string" || !isAbsolute(path) || !existsSync(path)) {
      return { status: "unavailable" };
    }
    const busy = options.busyTimeoutMs ?? 2_000;
    if (!Number.isInteger(busy) || busy < 0 || busy > 60_000) {
      return { status: "unavailable" };
    }
    let db: DatabaseSync | undefined;
    try {
      if (!statSync(path).isFile()) return { status: "unavailable" };
      // SQLite writes the WAL beside the resolved database file, so a symlinked
      // path must be followed before looking for the sidecar or opening it.
      const resolved = realpathSync(path);
      // A WAL sidecar means a writer is live or frames are uncheckpointed. The
      // immutable strategy below cannot see committed WAL content, so a WAL
      // store is read through a read-only connection inside one deferred read
      // transaction instead (#454). That yields a consistent snapshot without
      // checkpointing, deleting WAL or mutating anything; an unreadable or
      // locked WAL state is reported unavailable.
      const hasWal = existsSync(`${resolved}-wal`);
      // A read-only connection needs the shared-memory sidecar whenever WAL
      // content exists, and SQLite would create one if missing. Inspection
      // must not create files, so an orphaned WAL is reported unavailable.
      if (hasWal && !existsSync(`${resolved}-shm`)) return { status: "unavailable" };
      const identity = hasWal ? undefined : storeIdentity(resolved);
      if (!hasWal && !identity) return { status: "unavailable" };
      const fileUrl = pathToFileURL(resolved);
      // `immutable=1` reads without locking or creating `-wal`/`-shm`
      // sidecars; never use it when WAL content must be honoured.
      if (!hasWal) fileUrl.searchParams.set("immutable", "1");
      db = new DatabaseSync(fileUrl.href, { readOnly: true, timeout: busy });
      const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (version < 1 || version > SCHEMA_VERSION) {
        db.close();
        return { status: "unavailable" };
      }
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      if (!tables.has("operations") || !tables.has("pending_events")) {
        db.close();
        return { status: "unavailable" };
      }
      // Prepare both inspection statements now: compiling them proves the
      // columns they read exist, so an incompatible database is reported as
      // unavailable here instead of throwing from a later inspection call.
      const counts = db.prepare(COUNTS_SQL);
      const operation = db.prepare(OPERATION_SQL);
      // Quiescence must hold from the identity snapshot through the schema
      // read: a writer that committed in between leaves this connection with
      // stale pages, while the identity would describe the newer file and
      // every later check would pass. Reject the connection in that case.
      if (!hasWal) {
        if (existsSync(`${resolved}-wal`) || !unchanged(identity!, storeIdentity(resolved))) {
          db.close();
          return { status: "unavailable" };
        }
      } else {
        // Snapshot for the inspector's lifetime: readers see one committed
        // state and cannot affect writers. Closing rolls the transaction back.
        db.exec("BEGIN DEFERRED");
        db.prepare(COUNTS_SQL).get();
      }
      return {
        status: "available",
        inspector: new OperationInspector(
          db,
          options.now ?? Date.now,
          resolved,
          hasWal ? "snapshot" : "quiescent",
          identity,
          counts,
          operation,
        ),
      };
    } catch {
      // A corrupt or unreadable database is unavailable, never a crash and
      // never an excuse to repair it here.
      if (db?.isOpen) db.close();
      return { status: "unavailable" };
    }
  }

  /**
   * Run one read only while the file is provably unchanged. Checked before and
   * after the query: a change during the read discards the result, because the
   * immutable connection may have mixed pages from two versions of the file.
   */
  private read<T>(query: () => T): T {
    if (this.mode === "quiescent") {
      if (this.changed()) throw new OperationStoreChangedError();
      const value = query();
      if (this.changed()) throw new OperationStoreChangedError();
      return value;
    }
    // Snapshot mode: the open read transaction defines the view; a live writer
    // may change the file at any time without affecting this result.
    return query();
  }

  private changed(): boolean {
    if (!this.identity) return true;
    if (existsSync(`${this.resolvedPath}-wal`)) return true;
    return !unchanged(this.identity, storeIdentity(this.resolvedPath));
  }

  /**
   * Counts by operation status, in status order.
   * @throws OperationStoreChangedError when the file changed since opening.
   */
  statusCounts(): OperationStatusCount[] {
    const rows = this.read(() => this.counts.all()) as Array<{ status: string; count: number }>;
    return rows.map((row) => ({
      status: row.status as OperationStatus["status"],
      count: row.count,
    }));
  }

  /**
   * One operation by exact key, or undefined when the key is unknown.
   * @throws OperationStoreChangedError when the file changed since opening.
   */
  inspect(key: string): OperationInspection | undefined {
    if (!Key.safeParse(key).success) return undefined;
    const row = this.read(() => this.operation.get(key)) as InspectionRow | undefined;
    if (!row) return undefined;
    let artifact: OperationArtifact | undefined;
    if (row.artifact !== null) {
      try {
        artifact = logicalArtifact(JSON.parse(row.artifact));
      } catch {
        artifact = undefined;
      }
    }
    const leaseExpiresAt = row.lease_expires_at;
    const exhausted =
      row.status === "failed" ||
      (row.status === "claimed" &&
        row.attempts >= row.max_attempts &&
        (leaseExpiresAt === null || leaseExpiresAt <= this.now()));
    return {
      key,
      status: row.status as OperationStatus["status"],
      exhausted,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(leaseExpiresAt === null
        ? {}
        : { leaseExpiresAt: new Date(leaseExpiresAt).toISOString() }),
      ...(artifact ? { artifact } : {}),
      pendingEvents: { pending: row.pending_count ?? 0, sent: row.sent_count ?? 0 },
    };
  }

  close(): void {
    if (!this.db.isOpen) return;
    if (this.mode === "snapshot") {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already settled; closing still releases the connection.
      }
    }
    this.db.close();
  }
}
