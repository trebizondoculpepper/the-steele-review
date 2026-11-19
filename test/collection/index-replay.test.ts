import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
import { replayArchiveToIndex } from "../../src/collection/index-replay.js";
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
});
