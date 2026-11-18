import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { SearchHit } from "../../src/controllers/elasticsearch.js";
import { RESEARCH_ENTRY_SCHEMA_VERSION } from "../../src/research/research-entry.js";
import {
  MAX_REVISIONS,
  RESEARCH_INDEX_V1,
  ResearchRevisionConflictError,
  ResearchRevisionLimitError,
  ResearchStore,
  researchEntryId,
  type ResearchSearchIndex,
} from "../../src/research/research-store.js";

// Synthetic values only.
const external = {
  kind: "external" as const,
  url: "https://evidence.example.org/synthetic-report",
  title: "Synthetic evidence report",
  retrievedAt: "2026-02-01T00:00:00Z",
  lastCheckedAt: "2026-02-10T00:00:00Z",
  passage: "A synthetic report states the synthetic fee rose 3%.",
};
const CLAIM_ID = `sha256:${"12".repeat(32)}`;
const entry = (
  finding: "supported" | "contradicted" = "supported",
  limitation = "Synthetic only.",
) => ({
  schemaVersion: RESEARCH_ENTRY_SCHEMA_VERSION,
  question: "Did the synthetic council raise fees by 3%?",
  addressedClaims: [
    {
      claimId: CLAIM_ID,
      statement: "The synthetic council raised fees by 3%.",
      finding,
      evidence: [external],
    },
  ],
  explanation: { text: "Generated synthetic explanation.", generatedBy: "synthetic-model-v1" },
  limitations: [limitation],
  unresolvedGaps: [],
  provenance: {
    modelVersion: "synthetic-model-v1",
    promptVersion: "research-v1",
    createdAt: "2026-02-11T00:00:00Z",
  },
});

/** In-memory index with naive term matching, standing in for Elasticsearch. */
function fakeIndex() {
  const docs = new Map<string, Map<string, Record<string, unknown>>>();
  const versions = new Map<string, number>();
  const writes: Array<{ index: string; id: string }> = [];
  const searched: string[] = [];
  const index: ResearchSearchIndex = {
    async indexDocument(name, id, document, options) {
      writes.push({ index: name, id });
      if (!docs.has(name)) docs.set(name, new Map());
      const current = versions.get(`${name}/${id}`);
      if (options?.version !== undefined && current !== undefined && options.version <= current) {
        throw Object.assign(new Error("version conflict"), { category: "stale-version" });
      }
      if (options?.version !== undefined) versions.set(`${name}/${id}`, options.version);
      docs.get(name)!.set(id, document as Record<string, unknown>);
    },
    async search(name, query) {
      searched.push(name);
      const q = JSON.stringify(query).toLowerCase();
      const hits: SearchHit[] = [];
      for (const [id, doc] of docs.get(name) ?? []) {
        const text = JSON.stringify(doc).toLowerCase();
        if (["fees", CLAIM_ID].some((t) => q.includes(t) && text.includes(t))) {
          hits.push({ id, score: 1, source: doc });
        }
      }
      return hits;
    },
  };
  return { index, docs, writes, searched };
}

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-research-"));
  await mkdir(join(dir, "archive"));
  artifacts = new GitArtifactStore({
    repoPath: join(dir, "archive"),
    repository: "research-archive",
  });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ResearchStore", () => {
  it("uses a stable ID from the normalised question", () => {
    expect(researchEntryId("Did the  synthetic council raise fees by 3%? ")).toBe(
      researchEntryId("did the synthetic council raise fees by 3%?"),
    );
  });

  it("commits revisions to Git and requires each revision to name its predecessor", async () => {
    const { index } = fakeIndex();
    const store = new ResearchStore(artifacts, index);
    const first = await store.save(entry(), 0);
    expect(first).toMatchObject({
      revision: 1,
      artifact: { path: `research/${first.entryId}/v1.json` },
    });
    await expect(store.save(entry("contradicted"), 0)).rejects.toBeInstanceOf(
      ResearchRevisionConflictError,
    );
    const second = await store.save(entry("contradicted"), 1);
    expect(second.revision).toBe(2);
    expect((await store.latest(first.entryId))?.entry.addressedClaims[0]!.finding).toBe(
      "contradicted",
    );
    // The first revision remains readable at its exact commit.
    expect(
      JSON.parse(await artifacts.read({ ...first.artifact, sha256: first.artifact.hash.slice(7) }))
        .addressedClaims[0].finding,
    ).toBe("supported");
  });

  it("refuses revisions beyond what revision discovery can find", async () => {
    const { index } = fakeIndex();
    const store = new ResearchStore(artifacts, index);
    const entryId = researchEntryId(entry().question);
    // Pretend the entry already has MAX_REVISIONS revisions.
    (store as unknown as { latest: () => Promise<unknown> }).latest = async () => ({
      entryId,
      revision: MAX_REVISIONS,
      artifact: {},
      entry: entry("contradicted"),
    });
    await expect(store.save(entry(), MAX_REVISIONS)).rejects.toBeInstanceOf(
      ResearchRevisionLimitError,
    );
  });

  it("treats saving identical content as a no-op that repeats indexing safely", async () => {
    const { index, docs, writes } = fakeIndex();
    const store = new ResearchStore(artifacts, index);
    const first = await store.save(entry(), 0);
    const again = await store.save(entry(), 0);
    expect(again).toEqual(first);
    expect(await store.reindex(first.entryId)).toBe(true);
    expect(writes).toHaveLength(3);
    expect(docs.get(RESEARCH_INDEX_V1)?.size).toBe(1);
  });

  it("rejects invalid entries before storing anything", async () => {
    const { index, writes } = fakeIndex();
    const store = new ResearchStore(artifacts, index);
    const invalid = {
      ...entry(),
      addressedClaims: [{ ...entry().addressedClaims[0]!, evidence: [] }],
    };
    await expect(store.save(invalid, 0)).rejects.toThrow("external source");
    expect(writes).toHaveLength(0);
  });

  it("returns committed evidence with the explanation labelled as generated", async () => {
    const { index } = fakeIndex();
    const store = new ResearchStore(artifacts, index);
    const saved = await store.save(entry(), 0);
    const [byText] = await store.search({ text: "synthetic council fees" });
    expect(byText).toMatchObject({
      entryId: saved.entryId,
      revision: 1,
      matches: [{ claimId: CLAIM_ID, finding: "supported", evidence: [external] }],
      explanation: { generatedBy: "synthetic-model-v1", isEvidence: false },
      limitations: ["Synthetic only."],
    });
    const [byClaim] = await store.search({ claimId: CLAIM_ID });
    expect(byClaim?.entryId).toBe(saved.entryId);
    expect(await store.search({})).toEqual([]);
  });

  it("searches only the research corpus and ignores monitored-source documents", async () => {
    const fake = fakeIndex();
    const store = new ResearchStore(artifacts, fake.index);
    await store.save(entry(), 0);
    // A monitored-source document that mentions the same topic, in its own index and
    // (to test defence in depth) a malformed research-index document.
    await fake.index.indexDocument("steele-source-text-v1", "substack:x:y", { text: "fees rose" });
    await fake.index.indexDocument(RESEARCH_INDEX_V1, "intruder", {
      corpus: "monitored",
      text: "fees",
    });
    const results = await store.search({ text: "fees" });
    expect(fake.searched.every((name) => name === RESEARCH_INDEX_V1)).toBe(true);
    expect(results.map((r) => r.entryId)).toEqual([researchEntryId(entry().question)]);
  });

  it("never lets an older revision replace a newer indexed one", async () => {
    const fake = fakeIndex();
    const store = new ResearchStore(artifacts, fake.index);
    const first = await store.save(entry(), 0);
    await store.save(entry("contradicted"), 1);
    // A delayed indexing request for revision 1 arrives after revision 2.
    await (store as unknown as { indexStored(s: unknown): Promise<void> }).indexStored(first);
    const indexed = fake.docs.get(RESEARCH_INDEX_V1)!.get(first.entryId)!;
    expect(indexed.revision).toBe(2);
    const [hit] = await store.search({ text: "fees" });
    expect(hit?.matches[0]?.finding).toBe("contradicted");
  });

  it("keeps the reason for unresolved claims in results", async () => {
    const { index } = fakeIndex();
    const store = new ResearchStore(artifacts, index);
    const unresolved = entry();
    unresolved.addressedClaims = [
      {
        ...unresolved.addressedClaims[0]!,
        finding: "unresolved" as never,
        evidence: [],
        unresolvedReason: "No independent source reports the fee change.",
      } as never,
    ];
    await store.save(unresolved, 0);
    const [hit] = await store.search({ text: "fees" });
    expect(hit?.matches[0]).toMatchObject({
      finding: "unresolved",
      unresolvedReason: "No independent source reports the fee change.",
    });
  });

  it("drops index hits that Git cannot vouch for", async () => {
    const fake = fakeIndex();
    const store = new ResearchStore(artifacts, fake.index);
    const saved = await store.save(entry(), 0);
    const doc = fake.docs.get(RESEARCH_INDEX_V1)!.get(saved.entryId)!;
    fake.docs.get(RESEARCH_INDEX_V1)!.set(saved.entryId, {
      ...doc,
      artifact: { ...(doc.artifact as object), hash: `sha256:${"0".repeat(64)}` },
    });
    expect(await store.search({ text: "fees" })).toEqual([]);
  });
});

// Controlled integration test against a disposable Elasticsearch node.
const esUrl = process.env.STEELE_TEST_ES_URL;
describe.skipIf(!esUrl)("ResearchStore with Elasticsearch", () => {
  it("indexes into a strict research mapping and retrieves committed evidence", async () => {
    const { ElasticsearchController } = await import("../../src/controllers/elasticsearch.js");
    const { RESEARCH_INDEX_MAPPING } = await import("../../src/research/research-store.js");
    const { Client } = await import("@elastic/elasticsearch");
    const es = new ElasticsearchController(esUrl!);
    const admin = new Client({ node: esUrl! });
    const alias = `steele-research-test-${Date.now().toString(36)}`;
    try {
      await es.provisionIndex(alias, RESEARCH_INDEX_MAPPING);
      const store = new ResearchStore(
        artifacts,
        {
          indexDocument: (i, id, d) => es.indexDocument(i, id, d, { refresh: "wait_for" }),
          search: (i, q, o) => es.search(i, q, o),
        },
        alias,
      );
      const saved = await store.save(entry(), 0);
      await store.save(entry("contradicted"), 1);
      const results = await store.search({ text: "synthetic council fees" });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ entryId: saved.entryId, revision: 2 });
      expect(results[0]!.matches[0]!.finding).toBe("contradicted");
      expect((await store.search({ claimId: CLAIM_ID }))[0]?.entryId).toBe(saved.entryId);
      expect((await admin.count({ index: alias })).count).toBe(1);
    } finally {
      await admin.indices.delete({ index: `${alias}-000001` }).catch(() => undefined);
      await admin.close();
      await es.close();
    }
  }, 60_000);
});
