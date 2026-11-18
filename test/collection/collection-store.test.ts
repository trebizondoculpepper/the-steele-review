import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  CollectionStore,
  collectionArtifactPath,
  collectionKey,
  type CollectionRecord,
} from "../../src/collection/collection-store.js";
import { GitArtifactStore, type ArtifactRef } from "../../src/controllers/artifact-store.js";
import {
  OperationStore,
  type ClaimResult,
  type OperationClaim,
} from "../../src/controllers/operation-store.js";

let dir: string;
let clock: number;
let ops: OperationStore[];
let artifacts: GitArtifactStore;

const item = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  title: "A post",
};
const record = (
  text = "Collected text.",
  acquiredAt = "2026-02-01T00:00:00Z",
): CollectionRecord => ({
  item,
  ingestionReason: "backfill",
  text,
  complete: true,
  supplied: { transcript: [{ start: 0, end: 1, text }] },
  provenance: { sourceUrl: item.url, acquiredAt, method: "supplied-transcript" },
});
const events = (artifact: ArtifactRef) => [
  {
    eventId: `text-ready:${artifact.commit}`,
    subject: "steele.v1.content.extracted",
    payload: JSON.stringify({ artifact }),
  },
];
const held = (r: ClaimResult): OperationClaim => {
  if (r.kind !== "claimed") throw new Error(`expected claim, got ${r.kind}`);
  return r.claim;
};

/** Open a store as a fresh process would: new SQLite connection, same volume. */
function openStore(): CollectionStore {
  const op = new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock });
  ops.push(op);
  return new CollectionStore(op, artifacts);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-collection-"));
  clock = 1_000_000;
  ops = [];
  artifacts = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "test-archive" });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "archive"));
  await artifacts.initialise();
});
afterEach(async () => {
  for (const op of ops) op.close();
  await rm(dir, { recursive: true, force: true });
});

describe("CollectionStore", () => {
  it("uses stable keys and predictable artifact paths", () => {
    expect(collectionKey(item)).toBe("collect:substack/example-pub/a-post");
    expect(collectionArtifactPath(item)).toBe("substack/example-pub/a-post/collected.json");
  });

  it("commits the artifact, then completion with a pending event referencing it", async () => {
    const store = openStore();
    const { artifact, reconciled } = await store.commit(
      held(store.begin(item, "c1", 60_000)),
      record(),
      events,
    );
    expect(reconciled).toBe(false);
    expect(await store.read(artifact)).toEqual(record());
    expect(store.begin(item, "c2", 60_000)).toEqual({ kind: "completed", artifact });
    const [pending] = ops[0]!.duePendingEvents();
    expect(JSON.parse(pending!.payload).artifact).toEqual(artifact);
  });

  it("lets only one collector claim the same post concurrently", () => {
    const a = openStore();
    const b = openStore();
    expect(a.begin(item, "c1", 60_000).kind).toBe("claimed");
    expect(b.begin(item, "c2", 60_000).kind).toBe("busy");
  });

  it("reuses a completed result for duplicate input", async () => {
    const store = openStore();
    await store.commit(held(store.begin(item, "c1", 60_000)), record(), events);
    const again = store.begin(item, "c1", 60_000);
    expect(again.kind).toBe("completed");
    expect(ops[0]!.duePendingEvents()).toHaveLength(1);
  });

  it("recovers after a crash between artifact commit and completion", async () => {
    const first = openStore();
    const crashed = held(first.begin(item, "c1", 1_000));
    // Simulate the crash: artifact committed, completion never recorded.
    const orphan = await artifacts.write(
      collectionArtifactPath(item),
      `${JSON.stringify(record("First attempt text."), null, 2)}\n`,
    );
    clock += 1_001; // lease expires

    const restarted = openStore();
    const retry = held(restarted.begin(item, "c2", 60_000));
    const result = await restarted.commit(
      retry,
      record("Second attempt text.", "2026-02-02T00:00:00Z"),
      events,
    );
    expect(result).toEqual({ artifact: orphan, reconciled: true });
    expect((await restarted.read(result.artifact)).text).toBe("First attempt text.");
    // A stale attempt finishing late changes nothing: it gets the stored artifact and adds no events.
    const late = await first.commit(crashed, record(), events);
    expect(late.artifact).toEqual(orphan);
    expect(ops[1]!.duePendingEvents()).toHaveLength(1);
  });

  it("does not record completion when the artifact commit fails", async () => {
    const broken = new CollectionStore(
      new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock }),
      new GitArtifactStore({ repoPath: join(dir, "missing"), repository: "test-archive" }),
    );
    const claim = held(broken.begin(item, "c1", 60_000));
    await expect(broken.commit(claim, record(), events)).rejects.toThrow();
    expect(broken.begin(item, "c2", 60_000).kind).toBe("busy");
  });

  it("rejects media or unknown fields in the retained record", async () => {
    const store = openStore();
    const claim = held(store.begin(item, "c1", 60_000));
    const withMedia = {
      ...record(),
      supplied: { audioBytes: "AAAA" },
    } as unknown as CollectionRecord;
    await expect(store.commit(claim, withMedia, events)).rejects.toThrow();
    const extra = { ...record(), mediaUrl: "https://x.test/a.mp3" } as unknown as CollectionRecord;
    await expect(store.commit(claim, extra, events)).rejects.toThrow();
  });

  it("refuses a claim for a different post", async () => {
    const store = openStore();
    const claim = held(store.begin({ ...item, postId: "other-post" }, "c1", 60_000));
    await expect(store.commit(claim, record(), events)).rejects.toThrow("claim does not match");
  });

  it("bounds retries of failed attempts", () => {
    const store = openStore();
    store.fail(held(store.begin(item, "c1", 60_000, 2)), "transient", true);
    store.fail(held(store.begin(item, "c1", 60_000, 2)), "transient", true);
    expect(store.begin(item, "c1", 60_000, 2)).toEqual({
      kind: "exhausted",
      errorCode: "transient",
    });
  });
});
