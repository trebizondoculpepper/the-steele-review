import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
import {
  handleTextReadyEvent,
  type FulltextIndexPort,
} from "../../src/collection/indexing-handler.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { IndexingError } from "../../src/controllers/elasticsearch.js";
import { FULLTEXT_INDEX_MAPPING, FULLTEXT_INDEX_V1 } from "../../src/content/fulltext-document.js";
import { createTextReadyEvent } from "../../src/events/text-ready-event.js";

const item = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  title: "A synthetic post",
};
const record = (text: string, acquiredAt: string, complete = true): CollectionRecord => ({
  item,
  ingestionReason: "backfill",
  text,
  complete,
  supplied: {},
  provenance: { sourceUrl: item.url, acquiredAt, method: "supplied-transcript" },
});
const now = () => new Date("2026-03-01T00:00:00Z");

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-indexing-"));
  await mkdir(join(dir, "archive"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "test-archive" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
async function eventFor(r: CollectionRecord, overrides: Record<string, unknown> = {}) {
  const ref = await artifacts.write(
    `substack/example-pub/a-post/collected-${n++}.json`,
    `${JSON.stringify(r)}\n`,
  );
  return createTextReadyEvent({
    publicationId: item.publicationId,
    postId: item.postId,
    url: item.url,
    ingestionReason: "backfill",
    artifact: {
      repository: ref.repository,
      commit: ref.commit,
      path: ref.path,
      hash: `sha256:${ref.sha256}`,
    },
    acquisitionMethod: "supplied-transcript",
    complete: r.complete,
    ...overrides,
  });
}

/** In-memory index honouring external versions, with optional injected failures. */
function index(failures: Array<IndexingError> = []) {
  const docs = new Map<string, { version: number; doc: Record<string, unknown> }>();
  const timeouts: number[] = [];
  const port: FulltextIndexPort = {
    async indexDocument(name, id, doc, options) {
      timeouts.push(options?.timeoutMs ?? 0);
      const failure = failures.shift();
      if (failure) throw failure;
      const key = `${name}/${id}`;
      const current = docs.get(key);
      if (options?.version !== undefined && current && options.version <= current.version) {
        throw new IndexingError("stale-version", false);
      }
      docs.set(key, { version: options?.version ?? 0, doc: doc as Record<string, unknown> });
    },
  };
  return { port, docs, timeouts };
}

describe("handleTextReadyEvent", () => {
  it("indexes the projected record under its stable ID", async () => {
    const { port, docs, timeouts } = index();
    const event = await eventFor(record("First retrieval.", "2026-02-01T00:00:00.000Z"));
    const outcome = await handleTextReadyEvent({ event, artifacts, index: port, now });
    expect(outcome).toEqual({
      kind: "indexed",
      documentId: "substack:example-pub:a-post",
      version: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    expect(docs.get(`${FULLTEXT_INDEX_V1}/substack:example-pub:a-post`)!.doc.text).toBe(
      "First retrieval.",
    );
    expect(timeouts[0]).toBe(10_000);
  });

  it("treats duplicate delivery as a no-op on the same document", async () => {
    const { port, docs } = index();
    const event = await eventFor(record("Text.", "2026-02-01T00:00:00.000Z"));
    await handleTextReadyEvent({ event, artifacts, index: port, now });
    expect(await handleTextReadyEvent({ event, artifacts, index: port, now })).toEqual({
      kind: "stale",
      documentId: "substack:example-pub:a-post",
    });
    expect(docs.size).toBe(1);
  });

  it("does not let a delayed older retrieval overwrite newer text", async () => {
    const { port, docs } = index();
    const older = await eventFor(record("Older text.", "2026-02-01T00:00:00.000Z"));
    const newer = await eventFor(record("Newer text.", "2026-02-05T00:00:00.000Z"));
    expect((await handleTextReadyEvent({ event: newer, artifacts, index: port, now })).kind).toBe(
      "indexed",
    );
    expect((await handleTextReadyEvent({ event: older, artifacts, index: port, now })).kind).toBe(
      "stale",
    );
    expect(docs.get(`${FULLTEXT_INDEX_V1}/substack:example-pub:a-post`)!.doc.text).toBe(
      "Newer text.",
    );
  });

  it("rejects a mismatched source as a permanent failure", async () => {
    const { port, docs } = index();
    const event = await eventFor(record("Text.", "2026-02-01T00:00:00.000Z"), {
      url: "https://example-pub.substack.com/p/other",
    });
    expect(await handleTextReadyEvent({ event, artifacts, index: port, now })).toEqual({
      kind: "failed",
      reason: "source-mismatch",
    });
    const wrongPost = await eventFor(record("Text.", "2026-02-01T00:00:00.000Z"), {
      postId: "b-post",
    });
    expect(await handleTextReadyEvent({ event: wrongPost, artifacts, index: port, now })).toEqual({
      kind: "failed",
      reason: "identity-mismatch",
    });
    expect(docs.size).toBe(0);
  });

  it("asks for redelivery after a timeout, then succeeds", async () => {
    const { port, docs } = index([new IndexingError("timeout", true)]);
    const event = await eventFor(record("Text.", "2026-02-01T00:00:00.000Z"));
    expect(await handleTextReadyEvent({ event, artifacts, index: port, now })).toEqual({
      kind: "retry",
      reason: "timeout",
    });
    expect((await handleTextReadyEvent({ event, artifacts, index: port, now })).kind).toBe(
      "indexed",
    );
    expect(docs.size).toBe(1);
  });

  it("reports permanent index failures and incomplete content without writing", async () => {
    const rejected = index([new IndexingError("rejected", false)]);
    const event = await eventFor(record("Text.", "2026-02-01T00:00:00.000Z"));
    expect(await handleTextReadyEvent({ event, artifacts, index: rejected.port, now })).toEqual({
      kind: "failed",
      reason: "rejected",
    });
    const { port, docs } = index();
    const partial = await eventFor(record("Partial.", "2026-02-01T00:00:00.000Z", false));
    expect(await handleTextReadyEvent({ event: partial, artifacts, index: port, now })).toEqual({
      kind: "incomplete",
    });
    expect(docs.size).toBe(0);
  });

  it("bounds the request timeout", async () => {
    const { port, timeouts } = index();
    const event = await eventFor(record("Text.", "2026-02-01T00:00:00.000Z"));
    await handleTextReadyEvent({ event, artifacts, index: port, now, timeoutMs: 999_999 });
    expect(timeouts[0]).toBe(60_000);
  });
});

const esUrl = process.env.STEELE_TEST_ES_URL;
describe.skipIf(!esUrl)("handleTextReadyEvent with Elasticsearch", () => {
  it("keeps one document with the newest retrieval", async () => {
    const { ElasticsearchController } = await import("../../src/controllers/elasticsearch.js");
    const { Client } = await import("@elastic/elasticsearch");
    const es = new ElasticsearchController(esUrl!);
    const admin = new Client({ node: esUrl! });
    const alias = `steele-source-text-test-${Date.now().toString(36)}`;
    try {
      await es.provisionIndex(alias, FULLTEXT_INDEX_MAPPING);
      const port: FulltextIndexPort = {
        indexDocument: (i, id, d, o) => es.indexDocument(i, id, d, { ...o, refresh: "wait_for" }),
      };
      const older = await eventFor(record("Older text.", "2026-02-01T00:00:00.000Z"));
      const newer = await eventFor(record("Newer text.", "2026-02-05T00:00:00.000Z"));
      expect(
        (
          await handleTextReadyEvent({
            event: newer,
            artifacts,
            index: port,
            indexName: alias,
            now,
          })
        ).kind,
      ).toBe("indexed");
      expect(
        (
          await handleTextReadyEvent({
            event: newer,
            artifacts,
            index: port,
            indexName: alias,
            now,
          })
        ).kind,
      ).toBe("stale");
      expect(
        (
          await handleTextReadyEvent({
            event: older,
            artifacts,
            index: port,
            indexName: alias,
            now,
          })
        ).kind,
      ).toBe("stale");
      expect((await admin.count({ index: alias })).count).toBe(1);
      const stored = await admin.get({ index: alias, id: "substack:example-pub:a-post" });
      expect((stored._source as { text: string }).text).toBe("Newer text.");
    } finally {
      await admin.indices.delete({ index: `${alias}-000001` }).catch(() => undefined);
      await admin.close();
      await es.close();
    }
  }, 60_000);
});
