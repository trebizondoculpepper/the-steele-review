import { describe, expect, it } from "vite-plus/test";
import {
  PASSAGE_VECTOR_FIELD,
  PassageVectorStore,
  VectorSpaceError,
  passageVectorIndexName,
  passageVectorMapping,
  type PassageVectorIndex,
} from "../../src/content/passage-vectors.js";
import { splitPassages } from "../../src/content/passages.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import {
  EmbeddingController,
  inputHashFor,
  type EmbeddingModel,
  type EmbeddingProvider,
} from "../../src/controllers/embedding.js";
import type { SearchHit } from "../../src/controllers/elasticsearch.js";

const MODEL: EmbeddingModel = {
  provider: "fake",
  model: "embed-small",
  version: "1",
  dimensions: 4,
};
const TEXT =
  "The synthetic council raised fees by three percent. " +
  "A synthetic critic said the fees would harm residents. " +
  "Officials denied that any fee change had happened.";
const artifact = {
  repository: "test-archive",
  commit: "a".repeat(40),
  path: "substack/example-pub/a-post/collected.json",
  hash: `sha256:${"b".repeat(64)}`,
};

/** Deterministic toy embedding: keyword counts, so similarity is predictable. */
const toyVector = (text: string) => {
  const t = text.toLowerCase();
  return ["fee", "critic", "denied", "council"].map((w) => (t.includes(w) ? 1 : 0.01));
};
function provider(model = MODEL): EmbeddingProvider {
  return { model, maxBatchSize: 16, embed: async (texts) => texts.map(toyVector) };
}

function passages() {
  return splitPassages(
    { sourceId: "substack/example-pub/a-post", text: TEXT, sourceVersion: sourceVersionFor(TEXT) },
    { maxChars: 60, overlapChars: 0, minChars: 10 },
  ).passages;
}

function fakeIndex() {
  const docs = new Map<string, Map<string, Record<string, unknown>>>();
  const mappings = new Map<string, unknown>();
  const es: PassageVectorIndex = {
    async provisionIndex(alias, mapping) {
      if (mappings.has(alias)) return "unchanged";
      mappings.set(alias, mapping);
      docs.set(alias, new Map());
      return "created";
    },
    async indexDocument(index, id, document) {
      docs.get(index)!.set(id, document as Record<string, unknown>);
    },
    async knnSearch(index, request): Promise<SearchHit[]> {
      const cosine = (a: number[], b: number[]) => {
        const dot = a.reduce((s, v, i) => s + v * b[i]!, 0);
        const n = (x: number[]) => Math.sqrt(x.reduce((s, v) => s + v * v, 0));
        return dot / (n(a) * n(b));
      };
      return [...(docs.get(index)?.entries() ?? [])]
        .map(([id, doc]) => ({
          id,
          score: cosine(request.queryVector, doc[PASSAGE_VECTOR_FIELD] as number[]),
          source: Object.fromEntries(
            Object.entries(doc).filter(([k]) => k !== PASSAGE_VECTOR_FIELD),
          ),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, request.k);
    },
  };
  return { es, docs, mappings };
}

async function vectorsFor(model = MODEL) {
  const list = passages();
  const embedded = await new EmbeddingController({ provider: provider(model) }).embed(
    list.map((p) => ({ id: p.id, text: p.text, inputHash: inputHashFor(p.text) })),
  );
  return { list, embedded };
}

describe("passage vector mapping", () => {
  it("uses one index per vector space and declares dims and similarity", () => {
    expect(passageVectorIndexName(MODEL)).not.toBe(
      passageVectorIndexName({ ...MODEL, version: "2" }),
    );
    expect(passageVectorIndexName(MODEL)).not.toBe(
      passageVectorIndexName({ ...MODEL, dimensions: 8 }),
    );
    expect(passageVectorMapping(MODEL).properties[PASSAGE_VECTOR_FIELD]).toEqual({
      type: "dense_vector",
      dims: 4,
      index: true,
      similarity: "cosine",
    });
    expect(passageVectorMapping(MODEL).dynamic).toBe("strict");
  });
});

describe("PassageVectorStore", () => {
  it("stores passage identity, text, provenance, splitter and model with the vector", async () => {
    const { es, docs } = fakeIndex();
    const store = new PassageVectorStore(es, MODEL);
    expect(await store.provision()).toBe("created");
    const { list, embedded } = await vectorsFor();
    for (const [i, p] of list.entries()) await store.write(p, embedded[i]!, artifact);
    const stored = docs.get(store.indexName)!.get(list[0]!.id)!;
    expect(stored).toMatchObject({
      passageId: list[0]!.id,
      sourceId: "substack/example-pub/a-post",
      splitterVersion: list[0]!.splitterVersion,
      text: list[0]!.text,
      artifact,
      model: MODEL,
      vectorSpace: store.vectorSpace,
    });
    // Repeat writes keep one document per passage.
    await store.write(list[0]!, embedded[0]!, artifact);
    expect(docs.get(store.indexName)!.size).toBe(list.length);
  });

  it("returns nearest passages with exact text and provenance, not vectors", async () => {
    const { es } = fakeIndex();
    const store = new PassageVectorStore(es, MODEL);
    await store.provision();
    const { list, embedded } = await vectorsFor();
    for (const [i, p] of list.entries()) await store.write(p, embedded[i]!, artifact);
    const [top] = await store.nearest(toyVector("denied"), 1);
    expect(top!.text).toContain("denied");
    expect(top).not.toHaveProperty(PASSAGE_VECTOR_FIELD);
    expect(top!.artifact).toEqual(artifact);
  });

  it("rejects vectors and queries from an incompatible model or dimension", async () => {
    const { es } = fakeIndex();
    const store = new PassageVectorStore(es, MODEL);
    const { list } = await vectorsFor();
    const other = await vectorsFor({ ...MODEL, version: "2" });
    expect(() => store.document(list[0]!, other.embedded[0]!, artifact)).toThrow(VectorSpaceError);
    const { embedded } = await vectorsFor();
    expect(() => store.document(list[1]!, embedded[0]!, artifact)).toThrow("another passage");
    await expect(store.nearest([1, 2, 3])).rejects.toBeInstanceOf(VectorSpaceError);
    await expect(store.nearest([1, 2, 3, Number.NaN])).rejects.toBeInstanceOf(VectorSpaceError);
  });
});

// Controlled capability check against a disposable Elasticsearch node.
const esUrl = process.env.STEELE_TEST_ES_URL;
describe.skipIf(!esUrl)("Elasticsearch vector capability", () => {
  it("supports strict dense_vector mapping, kNN, filtering and dimension enforcement", async () => {
    const { ElasticsearchController } = await import("../../src/controllers/elasticsearch.js");
    const { Client } = await import("@elastic/elasticsearch");
    const admin = new Client({ node: esUrl! });
    const run = Date.now().toString(36);
    const model = { ...MODEL, version: `it-${run}` };
    const es = new ElasticsearchController(esUrl!);
    const store = new PassageVectorStore(
      {
        provisionIndex: (a, m) => es.provisionIndex(a, m),
        indexDocument: (i, id, d) => es.indexDocument(i, id, d, { refresh: "wait_for" }),
        knnSearch: (i, r) => es.knnSearch(i, r),
      },
      model,
    );
    try {
      const license = (await admin.license.get()).license.type;
      expect(["basic", "trial"]).toContain(license);
      expect(await store.provision()).toBe("created");
      const { list, embedded } = await vectorsFor(model);
      for (const [i, p] of list.entries()) await store.write(p, embedded[i]!, artifact);

      const [top] = await store.nearest(toyVector("denied"), 2);
      expect(top!.text).toContain("denied");
      const filtered = await store.nearest(toyVector("fee"), 5, {
        sourceId: "substack/other/post",
      });
      expect(filtered).toEqual([]);

      // Elasticsearch itself rejects a vector of the wrong dimension.
      await expect(
        es.indexDocument(store.indexName, "bad", {
          ...store.document(list[0]!, embedded[0]!, artifact),
          embedding: [1, 2, 3],
        }),
      ).rejects.toMatchObject({ category: "rejected" });

      // Other similarity functions are available at this tier too.
      for (const similarity of ["dot_product", "l2_norm", "max_inner_product"]) {
        const name = `steele-vector-probe-${similarity.replace(/_/g, "-")}-${run}`;
        await admin.indices.create({
          index: name,
          mappings: {
            properties: { v: { type: "dense_vector", dims: 2, index: true, similarity } },
          },
        });
        await admin.index({
          index: name,
          id: "1",
          document: { v: [0.6, 0.8] },
          refresh: "wait_for",
        });
        const r = await admin.search({
          index: name,
          knn: { field: "v", query_vector: [0.6, 0.8], k: 1, num_candidates: 1 },
        });
        expect(r.hits.hits).toHaveLength(1);
        await admin.indices.delete({ index: name });
      }
    } finally {
      await admin.indices.delete({ index: `${store.indexName}-000001` }).catch(() => undefined);
      await admin.close();
      await es.close();
    }
  }, 120_000);
});
