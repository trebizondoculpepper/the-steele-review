import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  OperationStore,
  SCHEMA_VERSION,
  type ClaimResult,
  type OperationClaim,
} from "../../src/controllers/operation-store.js";

let dir: string;
let path: string;
let clock: number;
const stores: OperationStore[] = [];
const open = () => {
  const s = new OperationStore({ path, now: () => clock });
  stores.push(s);
  return s;
};
const held = (r: ClaimResult): OperationClaim => {
  if (r.kind !== "claimed") throw new Error(`expected claim, got ${r.kind}`);
  return r.claim;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-publication-"));
  path = join(dir, "state.sqlite");
  clock = 1_000_000;
});
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await rm(dir, { recursive: true, force: true });
});

const KEY = "publish:substack/example-pub/a-post";
const artifact = {
  hash: `sha256:${"a".repeat(64)}`,
  ref: {
    repository: "drafts",
    commit: "c".repeat(40),
    path: "d.md",
    hash: `sha256:${"a".repeat(64)}`,
  },
};
const receipt = { url: "https://dest.example/p/a-post", publishedAt: "2026-03-01T00:00:00Z" };

describe("publication state transitions", () => {
  it("persists intent, then the destination draft, then a confirmed receipt", () => {
    const store = open();
    const claim = held(store.claim(KEY, "publisher-1", 60_000));
    expect(store.recordPublicationIntent(claim, artifact)).toMatchObject({ status: "intent" });
    expect(store.saveDestinationDraft(claim, "draft-123")).toMatchObject({
      status: "draft-saved",
      destinationDraftId: "draft-123",
    });
    expect(store.confirmPublished(claim, receipt)).toMatchObject({ status: "published", receipt });
    expect(store.publicationState(KEY)).toEqual({
      key: KEY,
      status: "published",
      artifactHash: artifact.hash,
      artifact: artifact.ref,
      destinationDraftId: "draft-123",
      receipt,
    });
  });

  it("treats duplicate delivery as idempotent and refuses a different artifact", () => {
    const store = open();
    const claim = held(store.claim(KEY, "p", 60_000));
    store.recordPublicationIntent(claim, artifact);
    store.saveDestinationDraft(claim, "draft-123");
    expect(store.recordPublicationIntent(claim, artifact)).toMatchObject({
      status: "draft-saved",
      destinationDraftId: "draft-123",
    });
    expect(() =>
      store.recordPublicationIntent(claim, { ...artifact, hash: `sha256:${"b".repeat(64)}` }),
    ).toThrow("artifact-mismatch");
    store.confirmPublished(claim, receipt);
    expect(store.confirmPublished(claim, receipt).status).toBe("published");
    expect(() =>
      store.confirmPublished(claim, { ...receipt, url: "https://other.example/x" }),
    ).toThrow("destination-conflict");
  });

  it("never overwrites a known destination draft ID", () => {
    const store = open();
    const claim = held(store.claim(KEY, "p", 60_000));
    store.recordPublicationIntent(claim, artifact);
    store.saveDestinationDraft(claim, "draft-123");
    expect(store.saveDestinationDraft(claim, "draft-123").destinationDraftId).toBe("draft-123");
    expect(() => store.saveDestinationDraft(claim, "draft-999")).toThrow("destination-conflict");
    expect(store.publicationState(KEY)?.destinationDraftId).toBe("draft-123");
  });

  it("rejects stale owners after a lease is reclaimed", () => {
    const store = open();
    const stale = held(store.claim(KEY, "p", 1_000));
    store.recordPublicationIntent(stale, artifact);
    clock += 1_001;
    const fresh = held(store.claim(KEY, "p", 60_000));
    expect(() => store.saveDestinationDraft(stale, "draft-stale")).toThrow("not-owner");
    expect(() => store.confirmPublished(stale, receipt)).toThrow("not-owner");
    expect(store.saveDestinationDraft(fresh, "draft-123").destinationDraftId).toBe("draft-123");
  });

  it("preserves the destination across an interrupted run and restart", () => {
    const first = open();
    const crashed = held(first.claim(KEY, "p1", 1_000));
    first.recordPublicationIntent(crashed, artifact);
    first.saveDestinationDraft(crashed, "draft-123");
    first.markPublicationUncertain(crashed); // lost publish response
    first.close();
    clock += 1_001;

    const restarted = open();
    const retry = held(restarted.claim(KEY, "p2", 60_000));
    const state = restarted.recordPublicationIntent(retry, artifact);
    expect(state).toMatchObject({ status: "uncertain", destinationDraftId: "draft-123" });
    // Read-back can resolve the uncertainty either way.
    expect(restarted.markPublicationUnpublished(retry).status).toBe("unpublished");
    expect(restarted.confirmPublished(retry, receipt).status).toBe("published");
  });

  it("enforces transition order", () => {
    const store = open();
    const claim = held(store.claim(KEY, "p", 60_000));
    expect(() => store.saveDestinationDraft(claim, "draft-1")).toThrow("invalid-transition");
    store.recordPublicationIntent(claim, artifact);
    expect(() => store.markPublicationUncertain(claim)).toThrow("invalid-transition");
    expect(() => store.confirmPublished(claim, receipt)).toThrow("invalid-transition");
    store.saveDestinationDraft(claim, "draft-1");
    store.confirmPublished(claim, receipt);
    expect(() => store.markPublicationUnpublished(claim)).toThrow("invalid-transition");
    expect(store.markPublicationUncertain(claim).status).toBe("published");
  });

  it("validates inputs", () => {
    const store = open();
    const claim = held(store.claim(KEY, "p", 60_000));
    expect(() => store.recordPublicationIntent(claim, { ...artifact, hash: "" })).toThrow(
      "invalid-input",
    );
    store.recordPublicationIntent(claim, artifact);
    expect(() => store.saveDestinationDraft(claim, "")).toThrow("invalid-input");
  });

  it("upgrades a version-1 database in place", () => {
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE operations (key TEXT PRIMARY KEY, status TEXT NOT NULL, owner TEXT,
        lease_expires_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
        artifact TEXT, error_code TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE pending_events (event_id TEXT PRIMARY KEY, operation_key TEXT NOT NULL,
        subject TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER);
      INSERT INTO operations (key, status, attempts, max_attempts, artifact, updated_at)
        VALUES ('collect:x', 'completed', 1, 5, '"kept"', 1);
      PRAGMA user_version = 1;
    `);
    raw.close();
    const store = open();
    expect(store.claim("collect:x", "p", 1_000)).toEqual({ kind: "completed", artifact: "kept" });
    const check = new DatabaseSync(path);
    expect(
      (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
    check.close();
    const claim = held(store.claim(KEY, "p", 60_000));
    expect(store.recordPublicationIntent(claim, artifact).status).toBe("intent");
  });
});
