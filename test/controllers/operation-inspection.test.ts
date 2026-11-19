import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import {
  OperationInspector,
  OperationStore,
  logicalArtifact,
} from "../../src/controllers/operation-store.js";

// Synthetic values only.
const NOW = 1_760_000_000_000;
const artifact = {
  repository: "synthetic-archive",
  commit: "0123456789abcdef0123456789abcdef01234567",
  path: "records/example.json",
  hash: `sha256:${"ab".repeat(32)}`,
};

const directory = () => mkdtempSync(join(tmpdir(), "steele-inspect-"));
const storeAt = (path: string) => new OperationStore({ path, now: () => NOW });

const claimOf = (result: ReturnType<OperationStore["claim"]>) => {
  if (result.kind !== "claimed") throw new Error(`unexpected claim result ${result.kind}`);
  return result.claim;
};

const openInspector = (path: string) => {
  const opened = OperationInspector.open(path);
  if (opened.status !== "available") throw new Error("inspector unavailable");
  return opened.inspector;
};

describe("OperationInspector", () => {
  it("reports a claimed operation without leaking owner or payload", () => {
    const dir = directory();
    const path = join(dir, "operations.db");
    const store = storeAt(path);
    store.claim("op-claimed", "worker-sentinel", 60_000);
    store.close();

    const info = openInspector(path).inspect("op-claimed");
    expect(info).toMatchObject({
      key: "op-claimed",
      status: "claimed",
      exhausted: false,
      attempts: 1,
      maxAttempts: 5,
      leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
      pendingEvents: { pending: 0, sent: 0 },
    });
    expect(info).not.toHaveProperty("artifact");
    expect(JSON.stringify(info)).not.toContain("worker-sentinel");
  });

  it("reports a completion artifact reference and pending/sent counts", () => {
    const dir = directory();
    const path = join(dir, "operations.db");
    const store = storeAt(path);
    const claim = claimOf(store.claim("op-done", "worker", 60_000));
    store.complete(claim, { artifact }, [
      { eventId: "event-1", subject: "synthetic", payload: "{}" },
    ]);

    let info = openInspector(path).inspect("op-done");
    expect(info).toMatchObject({ status: "completed", artifact });
    expect(info?.pendingEvents).toEqual({ pending: 1, sent: 0 });

    store.markEventSent("event-1");
    store.close();
    info = openInspector(path).inspect("op-done");
    expect(info?.pendingEvents).toEqual({ pending: 0, sent: 1 });
  });

  it("never exposes an artifact that is not a plain immutable reference", () => {
    const dir = directory();
    const path = join(dir, "operations.db");
    const store = storeAt(path);
    const claim = claimOf(store.claim("op-secret", "worker", 60_000));
    store.complete(claim, { ...artifact, token: "secret-sentinel" }, [
      { eventId: "event-2", subject: "synthetic", payload: '{"secret":"secret-sentinel"}' },
    ]);
    store.close();

    const info = openInspector(path).inspect("op-secret");
    expect(info).not.toHaveProperty("artifact");
    expect(JSON.stringify(info)).not.toContain("secret-sentinel");
  });

  it("counts operations by status", () => {
    const dir = directory();
    const path = join(dir, "operations.db");
    const store = storeAt(path);
    store.claim("a-claimed", "worker", 60_000);
    const failed = claimOf(store.claim("b-failed", "worker", 60_000));
    store.fail(failed, "synthetic-error", false);
    store.close();

    expect(openInspector(path).statusCounts()).toEqual([
      { status: "claimed", count: 1 },
      { status: "failed", count: 1 },
    ]);
  });

  it("returns undefined for an unknown or malformed key", () => {
    const dir = directory();
    const path = join(dir, "operations.db");
    storeAt(path).close();
    const inspector = openInspector(path);
    expect(inspector.inspect("no-such-key")).toBeUndefined();
    expect(inspector.inspect("")).toBeUndefined();
    expect(inspector.inspect("x".repeat(513))).toBeUndefined();
  });
});

describe("read-only open", () => {
  it("reports a missing store as unavailable and does not create it", () => {
    const dir = directory();
    const path = join(dir, "absent.db");
    expect(OperationInspector.open(path)).toEqual({ status: "unavailable" });
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a database whose schema is newer than this build", () => {
    const dir = directory();
    const path = join(dir, "newer.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE operations (key TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE pending_events (event_id TEXT PRIMARY KEY)");
    db.exec("PRAGMA user_version = 999");
    db.close();
    expect(OperationInspector.open(path).status).toBe("unavailable");
  });

  it("refuses a database with no recognisable schema", () => {
    const dir = directory();
    const path = join(dir, "empty.db");
    new DatabaseSync(path).close();
    expect(OperationInspector.open(path).status).toBe("unavailable");
  });

  it("does not change the database bytes, schema or rows", () => {
    const dir = directory();
    const path = join(dir, "operations.db");
    const store = storeAt(path);
    store.claim("op-stable", "worker", 60_000);
    store.close();

    const snapshot = () => {
      const db = new DatabaseSync(path, { readOnly: true });
      const state = {
        bytes: createHash("sha256").update(readFileSync(path)).digest("hex"),
        userVersion: db.prepare("PRAGMA user_version").get(),
        journalMode: db.prepare("PRAGMA journal_mode").get(),
        schema: db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
        operations: db.prepare("SELECT key, status, attempts FROM operations ORDER BY key").all(),
      };
      db.close();
      return state;
    };

    const before = snapshot();
    const inspector = openInspector(path);
    inspector.inspect("op-stable");
    inspector.statusCounts();
    inspector.close();
    expect(snapshot()).toEqual(before);
  });
});

describe("logicalArtifact", () => {
  it("normalises the reference shapes the stage writers store", () => {
    expect(logicalArtifact(artifact)).toEqual({ kind: "reference", ...artifact });
    expect(logicalArtifact({ artifact })).toEqual({ kind: "reference", ...artifact });
    expect(logicalArtifact({ ref: artifact })).toEqual({ kind: "reference", ...artifact });

    // CollectionStore records a bare ArtifactRef: sha256 without a scheme.
    const stored = {
      repository: artifact.repository,
      commit: artifact.commit,
      path: artifact.path,
      sha256: artifact.hash.replace(/^sha256:/, ""),
    };
    expect(logicalArtifact(stored)).toEqual({ kind: "reference", ...artifact });
    // ClaimWorker records it under claimsArtifact.
    expect(logicalArtifact({ claimsArtifact: stored })).toEqual({ kind: "reference", ...artifact });
  });

  it("reports the partial references brief and verification writers record", () => {
    expect(logicalArtifact({ commit: artifact.commit, path: artifact.path })).toEqual({
      kind: "partial",
      commit: artifact.commit,
      path: artifact.path,
    });
    // Verification stores { report: path, verdict }; only the path is exposed.
    expect(logicalArtifact({ report: artifact.path, verdict: "pass" })).toEqual({
      kind: "partial",
      path: artifact.path,
    });
  });

  it("rejects everything else, including payloads, credentials and private paths", () => {
    expect(logicalArtifact(null)).toBeUndefined();
    expect(logicalArtifact("artifact")).toBeUndefined();
    expect(logicalArtifact({ url: "https://example.org/x" })).toBeUndefined();
    expect(logicalArtifact({ indexed: 3, skipped: 1 })).toBeUndefined();
    expect(logicalArtifact({ ...artifact, token: "secret" })).toBeUndefined();
    expect(logicalArtifact({ artifact: { ...artifact, path: "/absolute/path" } })).toBeUndefined();
    expect(logicalArtifact({ report: artifact.path, token: "secret" })).toBeUndefined();

    // A legacy stored reference with the right field names is still rejected
    // when its values are private or physical.
    const stored = {
      repository: artifact.repository,
      commit: artifact.commit,
      path: artifact.path,
      sha256: artifact.hash.replace(/^sha256:/, ""),
    };
    expect(logicalArtifact({ ...stored, path: "/Users/private/records.json" })).toBeUndefined();
    expect(
      logicalArtifact({ ...stored, repository: "https://internal.example/archive" }),
    ).toBeUndefined();
    expect(
      logicalArtifact({ commit: artifact.commit, path: "/Users/private/records.json" }),
    ).toBeUndefined();
    expect(
      logicalArtifact({ report: "/Users/private/report.json", verdict: "pass" }),
    ).toBeUndefined();
  });
});
