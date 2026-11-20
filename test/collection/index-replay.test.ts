import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
import {
  MAX_REPLAY_SCAN,
  replayArchiveToIndex,
  type ReplayCheckpointState,
} from "../../src/collection/index-replay.js";
import type { FulltextIndexPort } from "../../src/collection/indexing-handler.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { IndexingError } from "../../src/controllers/elasticsearch.js";

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-replay-"));
  await mkdir(join(dir, "archive"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "test-archive" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const record = (postId: string, publishedAt?: string, complete = true): CollectionRecord => ({
  item: {
    publicationId: "example-pub",
    postId,
    url: `https://example-pub.substack.com/p/${postId}`,
    title: `Synthetic ${postId}`,
    ...(publishedAt ? { publishedAt } : {}),
  },
  ingestionReason: "backfill",
  text: `Synthetic text of ${postId}.`,
  complete,
  supplied: {},
  provenance: {
    sourceUrl: `https://example-pub.substack.com/p/${postId}`,
    acquiredAt: "2026-02-01T00:00:00.000Z",
    method: "article-html",
  },
});

async function archive(...records: CollectionRecord[]) {
  for (const r of records) {
    await artifacts.write(
      `substack/${r.item.publicationId}/${r.item.postId}/collected.json`,
      `${JSON.stringify(r)}\n`,
    );
  }
}

/** Fake index honouring external versioning like Elasticsearch. */
function versionedIndex(failIds: (id: string) => boolean = () => false) {
  const docs = new Map<string, { version: number; doc: Record<string, unknown> }>();
  const port: FulltextIndexPort = {
    async indexDocument(_index, id, document, options) {
      if (failIds(id)) throw new IndexingError("unavailable", true);
      const existing = docs.get(id);
      if (existing && options?.version !== undefined && options.version <= existing.version) {
        throw new IndexingError("stale-version", false);
      }
      docs.set(id, { version: options?.version ?? 0, doc: document as Record<string, unknown> });
    },
  };
  return { port, docs };
}

/** Records each checkpoint it is asked to save. */
function checkpointSink() {
  const states: ReplayCheckpointState[] = [];
  return {
    states,
    checkpoint: {
      async save(state: ReplayCheckpointState) {
        states.push(state);
      },
    },
  };
}

describe("replayArchiveToIndex", () => {
  it("rebuilds documents from committed records and reruns without duplicates", async () => {
    await archive(
      record("a", "2026-01-01T00:00:00Z"),
      record("b", "2026-02-01T00:00:00Z"),
      record("c", undefined, false),
    );
    const { port, docs } = versionedIndex();
    const first = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10 },
      artifacts,
      index: port,
    });
    expect(first).toMatchObject({
      ok: true,
      selected: 3,
      indexed: 2,
      incomplete: 1,
      failed: [],
      truncated: false,
    });
    expect(docs.size).toBe(2);
    expect([...docs.values()][0]!.doc).toMatchObject({ publicationId: "example-pub" });
    const rerun = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10 },
      artifacts,
      index: port,
    });
    expect(rerun).toMatchObject({ ok: true, indexed: 0, unchanged: 2 });
    expect(docs.size).toBe(2);
  });

  it("reports a partial failure honestly, then completes on rerun", async () => {
    await archive(record("a"), record("b"), record("c"));
    let broken = true;
    const { port, docs } = versionedIndex((id) => broken && id === "substack:example-pub:b");
    const partial = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10 },
      artifacts,
      index: port,
    });
    expect(partial.ok).toBe(false);
    expect(partial).toMatchObject({ selected: 3, indexed: 2 });
    expect(partial.failed).toEqual([
      { path: "substack/example-pub/b/collected.json", reason: "unavailable" },
    ]);
    broken = false;
    const rerun = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10 },
      artifacts,
      index: port,
    });
    expect(rerun).toMatchObject({ ok: true, indexed: 1, unchanged: 2 });
    expect(docs.size).toBe(3);
  });

  it("honours named posts, date range and the count bound", async () => {
    await archive(
      record("a", "2026-01-01T00:00:00Z"),
      record("b", "2026-02-01T00:00:00Z"),
      record("c", "2026-03-01T00:00:00Z"),
      record("d"),
    );
    const named = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", postIds: ["b", "d"], limit: 10 },
      artifacts,
      index: versionedIndex().port,
    });
    expect(named).toMatchObject({ selected: 2, indexed: 2 });
    const ranged = await replayArchiveToIndex({
      selection: {
        publicationId: "example-pub",
        from: "2026-01-15T00:00:00Z",
        to: "2026-03-31T00:00:00Z",
        limit: 10,
      },
      artifacts,
      index: versionedIndex().port,
    });
    expect(ranged).toMatchObject({ selected: 2, skipped: 2 });
    const bounded = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 1 },
      artifacts,
      index: versionedIndex().port,
    });
    expect(bounded).toMatchObject({ selected: 1, truncated: true });
  });

  it("compares the date range as instants across offsets", async () => {
    await archive(record("a", "2026-01-01T03:00:00+05:00"));
    const result = await replayArchiveToIndex({
      selection: {
        publicationId: "example-pub",
        from: "2025-12-31T21:00:00Z",
        to: "2025-12-31T23:00:00Z",
        limit: 5,
      },
      artifacts,
      index: versionedIndex().port,
    });
    expect(result).toMatchObject({ selected: 1, skipped: 0 });
  });

  it("reports unreadable records and requires a bounded selection", async () => {
    await artifacts.write("substack/example-pub/bad/collected.json", "not json\n");
    const result = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 5 },
      artifacts,
      index: versionedIndex().port,
    });
    expect(result.failed).toEqual([
      { path: "substack/example-pub/bad/collected.json", reason: "unreadable-record" },
    ]);
    await expect(
      replayArchiveToIndex({
        selection: { publicationId: "example-pub" } as never,
        artifacts,
        index: versionedIndex().port,
      }),
    ).rejects.toThrow();
    await expect(
      replayArchiveToIndex({
        selection: { publicationId: "example-pub", limit: 5_000 },
        artifacts,
        index: versionedIndex().port,
      }),
    ).rejects.toThrow();
  });

  it("rejects a record whose identity differs from its archive path", async () => {
    await artifacts.write(
      "substack/example-pub/a/collected.json",
      `${JSON.stringify(record("other"))}\n`,
    );
    const { port, docs } = versionedIndex();
    const result = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 5 },
      artifacts,
      index: port,
    });
    expect(result.failed).toEqual([
      { path: "substack/example-pub/a/collected.json", reason: "identity-mismatch" },
    ]);
    expect(docs.size).toBe(0);
  });

  it("reports interruption instead of success", async () => {
    await archive(record("a"), record("b"));
    const abort = new AbortController();
    abort.abort();
    const result = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10 },
      artifacts,
      index: versionedIndex().port,
      signal: abort.signal,
    });
    expect(result).toMatchObject({ ok: false, interrupted: true, selected: 0 });
  });

  it("reports truncation when the archive listing hits the scan cap", async () => {
    const capped = {
      list: async () =>
        Array.from({ length: MAX_REPLAY_SCAN }, (_, i) => `substack/example-pub/p${i}/other.json`),
      lookup: artifacts.lookup.bind(artifacts),
      read: artifacts.read.bind(artifacts),
    };
    const result = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10 },
      artifacts: capped,
      index: versionedIndex().port,
    });
    expect(result).toMatchObject({ selected: 0, truncated: true });
  });

  it("fails rather than reporting an empty archive when the path is not a repository", async () => {
    const missing = new GitArtifactStore({ repoPath: join(dir, "not-a-repo"), repository: "x" });
    await expect(missing.list("substack/example-pub", 10)).rejects.toThrow();
  });

  it("ignores other publications and non-record artifacts", async () => {
    await archive(record("a"));
    await artifacts.write(
      "substack/other-pub/x/collected.json",
      `${JSON.stringify(record("x"))}\n`,
    );
    await artifacts.write("substack/example-pub/a/claims.json", "{}\n");
    const result = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10 },
      artifacts,
      index: versionedIndex().port,
    });
    expect(result).toMatchObject({ selected: 1, indexed: 1 });
  });
});

describe("replay-index CLI", () => {
  it("rejects a malformed Elasticsearch URL without echoing it", async () => {
    const { main } = await import("../../src/cli/replay-index.js");
    const saved = { ...process.env };
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: string) => void errors.push(m);
    try {
      Object.assign(process.env, {
        ELASTICSEARCH_URL: "http://user:secret@host:99999999",
        STEELE_ARCHIVE_PATH: join(dir, "archive"),
        STEELE_ARCHIVE_REPOSITORY: "test-archive",
      });
      expect(await main(["--publication", "example-pub", "--limit", "1"])).toBe(2);
      expect(errors.join("\n")).not.toContain("secret");
    } finally {
      console.error = original;
      process.env = saved;
    }
  });
});

describe("GitArtifactStore.list", () => {
  it("lists stored paths under a prefix, bounded and sorted", async () => {
    await archive(record("b"), record("a"));
    expect(await artifacts.list("substack/example-pub", 10)).toEqual([
      "substack/example-pub/a/collected.json",
      "substack/example-pub/b/collected.json",
    ]);
    expect(await artifacts.list("substack/example-pub", 1)).toHaveLength(1);
    expect(await artifacts.list("substack/missing", 10)).toEqual([]);
  });
  it("replays exactly the archive as pinned at a commit", async () => {
    await archive(record("a", "2026-01-01T00:00:00Z"), record("b", "2026-02-01T00:00:00Z"));
    // The last archived record carries the commit that contains both posts.
    const pinnedRef = await artifacts.lookup("substack/example-pub/b/collected.json");
    expect(pinnedRef).toBeDefined();
    // Later work on the archive must not leak into a pinned load.
    await archive(record("c", "2026-03-01T00:00:00Z"));

    const { port, docs } = versionedIndex();
    const { states, checkpoint } = checkpointSink();
    const pinned = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10, commit: pinnedRef!.commit },
      artifacts,
      index: port,
      checkpoint,
    });
    expect(pinned).toMatchObject({ ok: true, selected: 2, indexed: 2, checkpointSaved: true });
    expect(docs.size).toBe(2);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ commit: pinnedRef!.commit, indexed: 2, unchanged: 0 });
  });

  it("enumerates paths from the pinned commit rather than the current tree", async () => {
    await archive(record("a", "2026-01-01T00:00:00Z"), record("b", "2026-02-01T00:00:00Z"));
    const head = (await artifacts.lookup("substack/example-pub/b/collected.json"))!.commit;
    // A record committed after the pin must not appear in a pinned load.
    await archive(record("late", "2026-04-01T00:00:00Z"));

    const { port, docs } = versionedIndex();
    const pinnedOnly = {
      read: artifacts.read.bind(artifacts),
      lookup: artifacts.lookup.bind(artifacts),
      lookupAt: artifacts.lookupAt.bind(artifacts),
      listAt: artifacts.listAt.bind(artifacts),
      // Proves enumeration does not fall back to the current working tree.
      list: async () => {
        throw new Error("list() must not be used for a pinned replay");
      },
    };
    const pinned = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10, commit: head },
      artifacts: pinnedOnly,
      index: port,
    });
    expect(pinned).toMatchObject({ ok: true, selected: 2, indexed: 2 });
    expect(docs.size).toBe(2);
  });

  it("reruns the same pinned load without duplicates and re-saves a stable checkpoint", async () => {
    await archive(record("a", "2026-01-01T00:00:00Z"), record("b", "2026-02-01T00:00:00Z"));
    const head = (await artifacts.lookup("substack/example-pub/b/collected.json"))!.commit;
    const { port, docs } = versionedIndex();
    const first = checkpointSink();
    await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10, commit: head },
      artifacts,
      index: port,
      checkpoint: first.checkpoint,
    });
    const second = checkpointSink();
    const rerun = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10, commit: head },
      artifacts,
      index: port,
      checkpoint: second.checkpoint,
    });
    expect(rerun).toMatchObject({ ok: true, indexed: 0, unchanged: 2, checkpointSaved: true });
    expect(docs.size).toBe(2);
    expect(second.states[0]).toMatchObject({ indexed: 0, unchanged: 2, commit: head });
  });

  it("does not save a checkpoint when a write failed", async () => {
    await archive(record("a"), record("b"));
    const { port } = versionedIndex(() => true);
    const { states, checkpoint } = checkpointSink();
    const failed = await replayArchiveToIndex({
      selection: { publicationId: "example-pub", limit: 10 },
      artifacts,
      index: port,
      checkpoint,
    });
    expect(failed.ok).toBe(false);
    expect(failed.failed.length).toBeGreaterThan(0);
    expect(failed.checkpointSaved).toBe(false);
    expect(states).toEqual([]);
  });

});
