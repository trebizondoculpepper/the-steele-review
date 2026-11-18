import { errors } from "@elastic/elasticsearch";
import { describe, expect, it } from "vite-plus/test";
import {
  ElasticsearchController,
  IndexingError,
  classifyIndexingError,
  type ElasticsearchClientLike,
} from "../../src/controllers/elasticsearch.js";
import {
  FULLTEXT_INDEX_MAPPING,
  createFulltextDocument,
  fulltextDocumentId,
} from "../../src/content/fulltext-document.js";

const doc = createFulltextDocument(
  {
    item: {
      publicationId: "example-pub",
      postId: "a-post",
      url: "https://example-pub.substack.com/p/a-post",
      title: "A synthetic post",
      publishedAt: "2026-01-02T00:00:00Z",
    },
    text: "Synthetic retained text about a test subject.",
    acquisitionOrigin: "transcript",
    artifact: {
      repository: "test-archive",
      commit: "a".repeat(40),
      path: "substack/example-pub/a-post/collected.json",
      hash: `sha256:${"b".repeat(64)}`,
    },
    sourceRetrievedAt: "2026-01-03T00:00:00Z",
  },
  () => new Date("2026-01-04T00:00:00Z"),
);

const responseError = (statusCode: number) =>
  new errors.ResponseError({
    body: { error: "detail from https://private.example:9200 with key" },
    statusCode,
    headers: {},
    warnings: null,
    meta: {} as never,
  });

function fakeClient(overrides: Partial<ElasticsearchClientLike> = {}) {
  const store = new Map<string, unknown>();
  const calls: Array<{ index: string; id: string; timeout: number }> = [];
  const client: ElasticsearchClientLike = {
    info: async () => ({}),
    close: async () => {},
    indices: {
      exists: async ({ index }) => index === "existing",
      create: async () => ({}),
    },
    index: async ({ index, id, document }, { requestTimeout }) => {
      calls.push({ index, id, timeout: requestTimeout });
      const key = `${index}/${id}`;
      const result = store.has(key) ? "updated" : "created";
      store.set(key, document);
      return { _index: index, _id: id, result, _version: calls.length };
    },
    ...overrides,
  };
  return { client, store, calls };
}

describe("classifyIndexingError", () => {
  it.each([
    [responseError(404), "missing-index", false],
    [responseError(400), "rejected", false],
    [responseError(401), "unauthorized", false],
    [responseError(403), "unauthorized", false],
    [responseError(429), "throttled", true],
    [responseError(503), "unavailable", true],
    [new errors.TimeoutError("timed out"), "timeout", true],
    [new errors.ConnectionError("connect ECONNREFUSED 10.0.0.1:9200"), "unavailable", true],
    [new Error("other"), "failed", true],
  ])("maps %s to %s", (error, category, retryable) => {
    const mapped = classifyIndexingError(error);
    expect(mapped).toMatchObject({ category, retryable });
    expect(mapped.message).not.toMatch(/private|10\.0\.0\.1/);
  });
});

describe("ElasticsearchController.indexDocument", () => {
  it("writes under a stable ID so a repeat replaces the same record", async () => {
    const fake = fakeClient();
    const es = new ElasticsearchController("http://unused", undefined, fake.client);
    const first = await es.indexFulltextDocument(doc, "existing");
    const second = await es.indexFulltextDocument(doc, "existing");
    expect(first).toMatchObject({ id: fulltextDocumentId(doc), result: "created" });
    expect(second).toMatchObject({ id: fulltextDocumentId(doc), result: "updated" });
    expect(fake.store.size).toBe(1);
  });

  it("refuses a missing index instead of letting it be auto-created", async () => {
    const fake = fakeClient();
    const es = new ElasticsearchController("http://unused", undefined, fake.client);
    await expect(es.indexFulltextDocument(doc, "absent")).rejects.toMatchObject({
      category: "missing-index",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("bounds the request timeout", async () => {
    const fake = fakeClient();
    const es = new ElasticsearchController("http://unused", undefined, fake.client);
    await es.indexDocument("existing", "id-1", {}, { timeoutMs: 999_999 });
    await es.indexDocument("existing", "id-2", {}, { timeoutMs: 1 });
    expect(fake.calls.map((c) => c.timeout)).toEqual([60_000, 1_000]);
  });

  it("propagates an injected failure as a sanitised category", async () => {
    const fake = fakeClient({
      index: async () => {
        throw responseError(503);
      },
    });
    const es = new ElasticsearchController("http://unused", undefined, fake.client);
    const error = await es.indexFulltextDocument(doc, "existing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IndexingError);
    expect(error).toMatchObject({ category: "unavailable", retryable: true });
    expect(String(error)).not.toContain("private");
  });

  it("validates the document before writing", async () => {
    const fake = fakeClient();
    const es = new ElasticsearchController("http://unused", undefined, fake.client);
    await expect(
      es.indexFulltextDocument({ ...doc, text: "" } as typeof doc, "existing"),
    ).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("ElasticsearchController.provisionIndex", () => {
  it("creates a missing index and leaves an existing one untouched", async () => {
    const created: string[] = [];
    const fake = fakeClient({
      indices: {
        exists: async ({ index }) => index === "existing",
        create: async ({ index }) => {
          created.push(index);
          return {};
        },
      },
    });
    const es = new ElasticsearchController("http://unused", undefined, fake.client);
    expect(await es.provisionIndex("existing", FULLTEXT_INDEX_MAPPING)).toBe("unchanged");
    expect(await es.provisionIndex("fresh", FULLTEXT_INDEX_MAPPING)).toBe("created");
    expect(created).toEqual(["fresh"]);
  });
});

// Controlled integration test against a disposable Elasticsearch node.
// Start one with scripts/es-test-server.sh and set STEELE_TEST_ES_URL.
const esUrl = process.env.STEELE_TEST_ES_URL;
describe.skipIf(!esUrl)("Elasticsearch integration", () => {
  it("indexes one record per stable ID, refuses unknown indices and rejects bad documents", async () => {
    const es = new ElasticsearchController(esUrl!);
    const index = `steele-test-${Date.now().toString(36)}`;
    const raw = (await import("@elastic/elasticsearch")).Client;
    const admin = new raw({ node: esUrl! });
    try {
      expect(await es.provisionIndex(index, FULLTEXT_INDEX_MAPPING)).toBe("created");
      expect(await es.provisionIndex(index, FULLTEXT_INDEX_MAPPING)).toBe("unchanged");

      const first = await es.indexFulltextDocument(doc, index, { refresh: "wait_for" });
      const second = await es.indexFulltextDocument(doc, index, { refresh: "wait_for" });
      expect(first.result).toBe("created");
      expect(second.result).toBe("updated");
      const count = await admin.count({ index });
      expect(count.count).toBe(1);
      const stored = await admin.get({ index, id: fulltextDocumentId(doc) });
      expect(stored._source).toEqual(doc);

      await expect(es.indexFulltextDocument(doc, `${index}-absent`)).rejects.toMatchObject({
        category: "missing-index",
      });
      expect(await admin.indices.exists({ index: `${index}-absent` })).toBe(false);

      // Strict mapping rejects an undeclared field.
      await expect(
        es.indexDocument(index, "bad", { ...doc, unexpected: true }),
      ).rejects.toMatchObject({ category: "rejected", retryable: false });
    } finally {
      await admin.indices.delete({ index }).catch(() => undefined);
      await admin.close();
      await es.close();
    }
  }, 60_000);
});
