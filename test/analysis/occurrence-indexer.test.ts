import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createClaim } from "../../src/analysis/claim.js";
import { CLAIM_OCCURRENCE_INDEX_MAPPING } from "../../src/analysis/claim-occurrence.js";
import { CLAIMS_EXTRACTED_EVENT_TYPE_V1 } from "../../src/analysis/claim-worker.js";
import {
  OccurrenceIndexer,
  type OccurrenceIndexPort,
} from "../../src/analysis/occurrence-indexer.js";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { IndexingError } from "../../src/controllers/elasticsearch.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";

const S1 = 'Dr Synthetic said "the towers are watching everyone".';
const S2 = "The council raised fees on 12 March 2026.";
const TEXT = `${S1} ${S2}`;
const item = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  title: "A synthetic post",
  publishedAt: "2026-04-01T09:00:00Z",
};
const record: CollectionRecord = {
  item,
  ingestionReason: "backfill",
  text: TEXT,
  complete: true,
  supplied: {},
  provenance: {
    sourceUrl: item.url,
    acquiredAt: "2026-04-02T00:00:00.000Z",
    method: "supplied-transcript",
  },
};

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-occ-index-"));
  await mkdir(join(dir, "archive"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "test-archive" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const ref = (r: { repository: string; commit: string; path: string; sha256: string }) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

async function scenario(extraClaims: unknown[] = [], claimsPath = "claims/a.json") {
  const source = ref(
    await artifacts
      .write("substack/example-pub/a-post/collected.json", `${JSON.stringify(record)}\n`)
      .catch(async () => (await artifacts.lookup("substack/example-pub/a-post/collected.json"))!),
  );
  const claimSource = { text: TEXT, sourceVersion: sourceVersionFor(TEXT), artifact: source };
  const extraction = {
    modelVersion: "fake/claims-1",
    promptVersion: "claim-extraction-v1",
    extractedAt: "2026-04-03T00:00:00Z",
  };
  const claims = [
    createClaim(
      {
        statement: S1,
        claimType: "factual",
        sourceVersion: claimSource.sourceVersion,
        span: { start: 0, end: S1.length },
        passage: S1,
        extraction,
      },
      claimSource,
    ),
    createClaim(
      {
        statement: S2,
        claimType: "factual",
        sourceVersion: claimSource.sourceVersion,
        span: { start: S1.length + 1, end: TEXT.length },
        passage: S2,
        dates: [{ text: "12 March 2026", value: "2026-03-12" }],
        extraction,
      },
      claimSource,
    ),
    ...extraClaims,
  ];
  const claimsRef = ref(
    await artifacts.write(claimsPath, `${JSON.stringify({ claims, sourceArtifact: source })}\n`),
  );
  const body = {
    specversion: "1.0",
    id: `evt-${claimsPath}`,
    source: "urn:steele:claims:extractor",
    type: CLAIMS_EXTRACTED_EVENT_TYPE_V1,
    time: "2026-04-03T00:00:00Z",
    subject: "substack/example-pub/a-post",
    datacontenttype: "application/json",
    data: {
      publicationId: "example-pub",
      postId: "a-post",
      ingestionReason: "backfill",
      claimsArtifact: claimsRef,
      sourceArtifact: source,
      status: "complete",
      claimCount: claims.length,
      modelVersion: "fake/claims-1",
      promptVersion: "claim-extraction-v1",
    },
  };
  const m = {
    data: new TextEncoder().encode(JSON.stringify(body)),
    deliveryCount: 1,
    acks: 0,
    naks: [] as number[],
    terms: 0,
    ack: async () => {
      m.acks++;
    },
    nak: (d?: number) => {
      m.naks.push(d ?? 0);
    },
    term: () => {
      m.terms++;
    },
    working: () => {},
  };
  return m as DeliveredMessage & typeof m;
}

function index(failOn: number[] = []) {
  const docs = new Map<string, Record<string, unknown>>();
  let call = 0;
  const port: OccurrenceIndexPort = {
    async indexDocument(_i, id, doc) {
      call++;
      if (failOn.includes(call)) throw new IndexingError("unavailable", true);
      docs.set(id, doc as Record<string, unknown>);
    },
  };
  return { port, docs };
}

const indexer = (port: OccurrenceIndexPort) =>
  new OccurrenceIndexer({ artifacts, index: port, operations, owner: "occ", retryDelayMs: 0 });

describe("OccurrenceIndexer", () => {
  it("indexes one occurrence per claim with spans, dates and unknown attribution", async () => {
    const { port, docs } = index();
    const m = await scenario();
    expect(await indexer(port).handle(m)).toEqual({ kind: "indexed", indexed: 2, skipped: 0 });
    expect(m.acks).toBe(1);
    const all = [...docs.values()];
    expect(all.map((d) => d.speaker)).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
    expect(all[0]).toMatchObject({
      passage: S1,
      span: { start: 0, end: S1.length },
      sourcePublishedAt: item.publishedAt,
    });
    expect(all[1]).toMatchObject({
      assertionDates: [{ text: "12 March 2026", value: "2026-03-12" }],
    });
    expect(JSON.stringify(all)).not.toMatch(/verdict|isTrue|false"/);
  });

  it("does not add duplicates on redelivery or overlapping backfill", async () => {
    const { port, docs } = index();
    await indexer(port).handle(await scenario());
    // Redelivery of the same claim set is recognised without re-indexing.
    expect((await indexer(port).handle(await scenario([], "claims/a-copy.json"))).kind).toBe(
      "already-indexed",
    );
    // An overlapping backfill produces a different claim set with the same claims.
    const overlap = await scenario([{ statement: "x" }], "claims/backfill.json");
    expect((await indexer(port).handle(overlap)).kind).toBe("indexed");
    expect(docs.size).toBe(2);
  });

  it("redelivers after a partial index failure and completes on retry", async () => {
    const failing = index([2]);
    const m = await scenario();
    expect(await indexer(failing.port).handle(m)).toEqual({ kind: "retry", reason: "unavailable" });
    expect(m.acks).toBe(0);
    expect(failing.docs.size).toBe(1);
    const healthy = index();
    healthy.docs.set([...failing.docs.keys()][0]!, {});
    expect((await indexer(healthy.port).handle(await scenario([], "claims/retry.json"))).kind).toBe(
      "indexed",
    );
  });

  it("skips claims that no longer validate against the source", async () => {
    const { port, docs } = index();
    const bogus = { statement: "Invented", passage: "Not in the text" };
    expect(await indexer(port).handle(await scenario([bogus], "claims/bogus.json"))).toEqual({
      kind: "indexed",
      indexed: 2,
      skipped: 1,
    });
    expect(docs.size).toBe(2);
  });

  it("terminates malformed events", async () => {
    const m = await scenario();
    m.data = new TextEncoder().encode("{}");
    expect(await indexer(index().port).handle(m)).toEqual({ kind: "invalid-event" });
    expect(m.terms).toBe(1);
  });
});

const esUrl = process.env.STEELE_TEST_ES_URL;
describe.skipIf(!esUrl)("OccurrenceIndexer with Elasticsearch", () => {
  it("indexes into the strict claim-occurrence mapping without duplicates", async () => {
    const { ElasticsearchController } = await import("../../src/controllers/elasticsearch.js");
    const { Client } = await import("@elastic/elasticsearch");
    const es = new ElasticsearchController(esUrl!);
    const admin = new Client({ node: esUrl! });
    const alias = `steele-claim-occurrences-test-${Date.now().toString(36)}`;
    try {
      await es.provisionIndex(alias, CLAIM_OCCURRENCE_INDEX_MAPPING);
      const port: OccurrenceIndexPort = {
        indexDocument: (i, id, d) => es.indexDocument(i, id, d, { refresh: "wait_for" }),
      };
      const worker = new OccurrenceIndexer({
        artifacts,
        index: port,
        indexName: alias,
        operations,
        owner: "occ",
      });
      expect((await worker.handle(await scenario())).kind).toBe("indexed");
      expect(
        (await worker.handle(await scenario([{ statement: "x" }], "claims/again.json"))).kind,
      ).toBe("indexed");
      expect((await admin.count({ index: alias })).count).toBe(2);
    } finally {
      await admin.indices.delete({ index: `${alias}-000001` }).catch(() => undefined);
      await admin.close();
      await es.close();
    }
  }, 60_000);
});
