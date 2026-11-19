import { describe, expect, it } from "vite-plus/test";
import {
  createFulltextDocument,
  FULLTEXT_INDEX_MAPPING,
  sourceVersionFor,
} from "../../src/content/fulltext-document.js";
import { DEFAULT_CHUNKING, PassageVectorStore } from "../../src/content/passage-vectors.js";
import { splitPassages } from "../../src/content/passages.js";
import {
  EmbeddingController,
  inputHashFor,
  type EmbeddingModel,
} from "../../src/controllers/embedding.js";
import type { SearchHit } from "../../src/controllers/elasticsearch.js";
import {
  PassageRetriever,
  RRF_K,
  type RetrievalIndexPort,
} from "../../src/retrieval/passage-retrieval.js";

const MODEL: EmbeddingModel = { provider: "fake", model: "toy", version: "1", dimensions: 4 };
const CHUNKING = { ...DEFAULT_CHUNKING, maxChars: 80, overlapChars: 0, minChars: 10 };
const toy = (text: string) => {
  const t = text.toLowerCase();
  return ["towers", "meters", "fees", "vaccine"].map((w) => (t.includes(w) ? 1 : 0.01));
};
const artifact = (n: number) => ({
  repository: "test-archive",
  commit: String(n)
    .repeat(40)
    .slice(0, 40)
    .replace(/[^0-9a-f]/g, "a"),
  path: `substack/pub-${n}/collected.json`,
  hash: `sha256:${"b".repeat(64)}`,
});

const POSTS = [
  {
    publicationId: "pub-a",
    postId: "towers",
    publishedAt: "2026-01-10T00:00:00Z",
    text: "The synthetic towers are watching everyone. Residents say the towers hum at night.",
  },
  {
    publicationId: "pub-a",
    postId: "meters",
    publishedAt: "2026-02-10T00:00:00Z",
    text: "New synthetic meters were installed. The meters report usage every minute.",
  },
  {
    publicationId: "pub-b",
    postId: "fees",
    publishedAt: "2026-03-10T00:00:00Z",
    text: "The council raised fees again. Critics say the fees fund the towers project.",
  },
];

function docs() {
  return POSTS.map((p, i) =>
    createFulltextDocument(
      {
        item: {
          publicationId: p.publicationId,
          postId: p.postId,
          url: `https://${p.publicationId}.substack.com/p/${p.postId}`,
          title: p.postId,
          publishedAt: p.publishedAt,
        },
        text: p.text,
        acquisitionOrigin: "transcript",
        artifact: artifact(i + 1),
        sourceRetrievedAt: "2026-04-01T00:00:00Z",
      },
      () => new Date("2026-04-02T00:00:00Z"),
    ),
  );
}

describe("PassageRetriever (fake index)", () => {
  const fulltextHits = (): SearchHit[] =>
    docs().map((d, i) => ({ id: d.postId, score: 3 - i, source: d }));

  it("falls back to keyword-only with exact passage provenance when no embedder is configured", async () => {
    const port: RetrievalIndexPort = {
      search: async () => fulltextHits(),
      knnSearch: async () => {
        throw new Error("must not be called");
      },
    };
    const result = await new PassageRetriever({ index: port, chunking: CHUNKING }).retrieve({
      text: "towers hum",
    });
    expect(result).toMatchObject({ mode: "keyword-only", semanticUnavailable: "no-embedder" });
    const first = result.passages[0]!;
    const post = POSTS[0]!;
    expect(post.text.slice(first.start, first.end)).toBe(first.text);
    expect(first.text).toContain("hum");
    expect(first.artifact).toEqual(artifact(1));
    expect(first.signals).toEqual({ keywordRank: 1, fused: 1 / (RRF_K + 1) });
  });

  it("deduplicates passages found by both methods and ranks them first", async () => {
    const d = docs();
    const passage = splitPassages(
      {
        sourceId: "substack/pub-b/fees",
        text: d[2]!.text,
        sourceVersion: d[2]!.sourceVersion,
        publishedAt: d[2]!.publishedAt,
      },
      { maxChars: CHUNKING.maxChars, overlapChars: 0, minChars: 10 },
    ).passages.find((p) => p.text.includes("towers project"))!;
    const port: RetrievalIndexPort = {
      search: async () => fulltextHits(),
      knnSearch: async () => [
        {
          id: passage.id,
          score: 0.9,
          source: {
            schemaVersion: 1,
            passageId: passage.id,
            sourceId: passage.sourceId,
            sourceVersion: passage.sourceVersion,
            splitterVersion: passage.splitterVersion,
            chunking: "x",
            start: passage.start,
            end: passage.end,
            text: passage.text,
            publishedAt: passage.publishedAt,
            artifact: artifact(3),
            inputHash: inputHashFor(passage.text),
            vectorSpace: "fake/toy@1#4",
            model: MODEL,
          },
        },
      ],
    };
    const result = await new PassageRetriever({
      index: port,
      chunking: CHUNKING,
      semantic: { model: MODEL, embedQuery: async (t) => toy(t) },
    }).retrieve({ text: "towers", limit: 2 });
    expect(result.mode).toBe("hybrid");
    expect(result.passages).toHaveLength(2);
    const ids = result.passages.map((p) => p.passageId);
    expect(new Set(ids).size).toBe(ids.length);
    const both = result.passages.find((p) => p.passageId === passage.id)!;
    expect(both.signals.keywordRank).toBeDefined();
    expect(both.signals.semanticRank).toBe(1);
  });

  it("reports embedding failure and still answers from keywords", async () => {
    const port: RetrievalIndexPort = {
      search: async () => fulltextHits(),
      knnSearch: async () => [],
    };
    const result = await new PassageRetriever({
      index: port,
      chunking: CHUNKING,
      semantic: {
        model: MODEL,
        embedQuery: async () => {
          throw new Error("provider down");
        },
      },
    }).retrieve({ text: "meters" });
    expect(result).toMatchObject({ mode: "keyword-only", semanticUnavailable: "embedding-failed" });
    expect(result.passages.length).toBeGreaterThan(0);
  });

  it("selects passages using short query terms such as 5G", async () => {
    const shortDoc = createFulltextDocument(
      {
        item: {
          publicationId: "pub-c",
          postId: "short",
          url: "https://pub-c.substack.com/p/short",
          title: "short",
        },
        text: "Nothing relevant in this opening sentence at all. The 5G masts went up last week in town.",
        acquisitionOrigin: "transcript",
        artifact: artifact(4),
        sourceRetrievedAt: "2026-04-01T00:00:00Z",
      },
      () => new Date("2026-04-02T00:00:00Z"),
    );
    const port: RetrievalIndexPort = {
      search: async () => [{ id: "s", score: 1, source: shortDoc }],
      knnSearch: async () => [],
    };
    const [top] = (
      await new PassageRetriever({ index: port, chunking: { ...CHUNKING, maxChars: 50 } }).retrieve(
        { text: "5G" },
      )
    ).passages;
    expect(top!.text).toContain("5G");
  });

  it("matches whole tokens, so AI does not match inside said", async () => {
    const doc = createFulltextDocument(
      {
        item: {
          publicationId: "pub-d",
          postId: "ai",
          url: "https://pub-d.substack.com/p/ai",
          title: "ai",
        },
        text: "A resident said nothing useful about it today. Later the AI system was switched on.",
        acquisitionOrigin: "transcript",
        artifact: artifact(5),
        sourceRetrievedAt: "2026-04-01T00:00:00Z",
      },
      () => new Date("2026-04-02T00:00:00Z"),
    );
    const port: RetrievalIndexPort = {
      search: async () => [{ id: "a", score: 1, source: doc }],
      knnSearch: async () => [],
    };
    const [top] = (
      await new PassageRetriever({ index: port, chunking: { ...CHUNKING, maxChars: 50 } }).retrieve(
        { text: "AI" },
      )
    ).passages;
    expect(top!.text).toContain("AI system");
  });

  it("validates the query and bounds the limit", async () => {
    const port: RetrievalIndexPort = { search: async () => [], knnSearch: async () => [] };
    const retriever = new PassageRetriever({ index: port });
    await expect(retriever.retrieve({ text: " " })).rejects.toThrow();
    await expect(retriever.retrieve({ text: "x", limit: 500 })).rejects.toThrow();
  });
});

const esUrl = process.env.STEELE_TEST_ES_URL;
describe.skipIf(!esUrl)("PassageRetriever with Elasticsearch", () => {
  it("applies filters, limits, deduplication and provenance across both methods", async () => {
    const { ElasticsearchController } = await import("../../src/controllers/elasticsearch.js");
    const { Client } = await import("@elastic/elasticsearch");
    const es = new ElasticsearchController(esUrl!);
    const admin = new Client({ node: esUrl! });
    const run = Date.now().toString(36);
    const fulltext = `steele-source-text-test-${run}`;
    const model = { ...MODEL, version: `it-${run}` };
    const store = new PassageVectorStore(
      {
        provisionIndex: (a, m) => es.provisionIndex(a, m),
        indexDocument: (i, id, d) => es.indexDocument(i, id, d, { refresh: "wait_for" }),
        knnSearch: (i, r) => es.knnSearch(i, r),
      },
      model,
      CHUNKING,
    );
    try {
      await es.provisionIndex(fulltext, FULLTEXT_INDEX_MAPPING);
      await store.provision();
      const embedder = new EmbeddingController({
        provider: { model, maxBatchSize: 16, embed: async (texts) => texts.map(toy) },
      });
      for (const doc of docs()) {
        await es.indexDocument(fulltext, `substack:${doc.publicationId}:${doc.postId}`, doc, {
          refresh: "wait_for",
        });
        const passages = splitPassages(
          {
            sourceId: `substack/${doc.publicationId}/${doc.postId}`,
            text: doc.text,
            sourceVersion: sourceVersionFor(doc.text),
            publishedAt: doc.publishedAt,
          },
          { maxChars: CHUNKING.maxChars, overlapChars: 0, minChars: 10 },
        ).passages;
        const vectors = await embedder.embed(
          passages.map((p) => ({ id: p.id, text: p.text, inputHash: inputHashFor(p.text) })),
        );
        for (const [i, p] of passages.entries()) await store.write(p, vectors[i]!, doc.artifact);
      }
      const retriever = new PassageRetriever({
        index: es,
        fulltextIndex: fulltext,
        chunking: CHUNKING,
        semantic: { model, embedQuery: async (t) => toy(t) },
      });

      const all = await retriever.retrieve({ text: "towers", limit: 5 });
      expect(all.mode).toBe("hybrid");
      expect(new Set(all.passages.map((p) => p.passageId)).size).toBe(all.passages.length);
      expect(all.passages[0]!.signals.keywordRank).toBeDefined();
      expect(all.passages[0]!.signals.semanticRank).toBeDefined();
      for (const p of all.passages) {
        const post = POSTS.find((x) => x.postId === p.postId)!;
        expect(post.text.slice(p.start, p.end)).toBe(p.text);
      }

      // Every result, including semantic-only ones, carries its canonical URL.
      for (const p of all.passages)
        expect(p.url).toBe(`https://${p.publicationId}.substack.com/p/${p.postId}`);

      const pubA = await retriever.retrieve({ text: "towers", publicationId: "pub-a" });
      expect(pubA.passages.every((p) => p.publicationId === "pub-a")).toBe(true);

      const dated = await retriever.retrieve({
        text: "meters fees towers",
        from: "2026-02-01T00:00:00Z",
        to: "2026-02-28T00:00:00Z",
      });
      expect(dated.passages.map((p) => p.postId)).toEqual(["meters"]);

      expect((await retriever.retrieve({ text: "towers", limit: 1 })).passages).toHaveLength(1);

      // Strict upper bound and post exclusion are applied inside both searches.
      const earlier = await retriever.retrieve({
        text: "towers meters fees",
        before: "2026-03-10T00:00:00Z",
        excludePostIds: ["towers"],
        publicationId: "pub-a",
      });
      expect(earlier.passages.map((p) => p.postId)).toEqual(["meters"]);
    } finally {
      for (const alias of [fulltext, store.indexName]) {
        await admin.indices.delete({ index: `${alias}-000001` }).catch(() => undefined);
      }
      await admin.close();
      await es.close();
    }
  }, 120_000);
});
