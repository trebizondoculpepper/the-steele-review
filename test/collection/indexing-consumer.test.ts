import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
import { IndexingConsumer } from "../../src/collection/indexing-consumer.js";
import type { FulltextIndexPort } from "../../src/collection/indexing-handler.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { IndexingError } from "../../src/controllers/elasticsearch.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { FULLTEXT_INDEX_MAPPING, FULLTEXT_INDEX_V1 } from "../../src/content/fulltext-document.js";
import { TEXT_READY_SUBJECT, createTextReadyEvent } from "../../src/events/text-ready-event.js";

const item = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  title: "A synthetic post",
};
const record = (complete = true): CollectionRecord => ({
  item,
  ingestionReason: "backfill",
  text: "Synthetic retained text.",
  complete,
  supplied: {},
  provenance: {
    sourceUrl: item.url,
    acquiredAt: "2026-02-01T00:00:00.000Z",
    method: "supplied-transcript",
  },
});

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-index-consumer-"));
  await mkdir(join(dir, "archive"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "test-archive" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

async function eventBytes(r = record(), path = "substack/example-pub/a-post/collected.json") {
  const ref = await artifacts.write(path, `${JSON.stringify(r)}\n`);
  const event = createTextReadyEvent({
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
  });
  return { event, bytes: new TextEncoder().encode(JSON.stringify(event.toJSON())) };
}

type Msg = DeliveredMessage & { acks: number; naks: number[]; terms: number };
function msg(data: Uint8Array): Msg {
  const m: Msg = {
    data,
    deliveryCount: 1,
    acks: 0,
    naks: [],
    terms: 0,
    ack: async () => {
      m.acks++;
    },
    nak: (d) => {
      m.naks.push(d ?? 0);
    },
    term: () => {
      m.terms++;
    },
    working: () => {},
  };
  return m;
}

function index(failures: IndexingError[] = []) {
  const docs = new Map<string, number>();
  const port: FulltextIndexPort = {
    async indexDocument(_name, id, _doc, options) {
      const f = failures.shift();
      if (f) throw f;
      const current = docs.get(id);
      if (current !== undefined && options?.version !== undefined && options.version <= current) {
        throw new IndexingError("stale-version", false);
      }
      docs.set(id, options?.version ?? 0);
    },
  };
  return { port, docs };
}

const consumer = (port: FulltextIndexPort) =>
  new IndexingConsumer({
    artifacts,
    index: port,
    operations,
    owner: "test-worker",
    retryDelayMs: 5,
  });

describe("IndexingConsumer", () => {
  it("acknowledges after indexing and on duplicate delivery", async () => {
    const { port, docs } = index();
    const { bytes } = await eventBytes();
    const first = msg(bytes);
    const again = msg(bytes);
    expect(await consumer(port).handle(first)).toEqual({ action: "ack", outcome: "indexed" });
    expect(await consumer(port).handle(again)).toEqual({ action: "ack", outcome: "stale" });
    expect([first.acks, again.acks]).toEqual([1, 1]);
    expect(docs.size).toBe(1);
  });

  it("defers retryable failures without acknowledging", async () => {
    const { port } = index([new IndexingError("unavailable", true)]);
    const { bytes } = await eventBytes();
    const m = msg(bytes);
    expect(await consumer(port).handle(m)).toEqual({ action: "nak", reason: "unavailable" });
    expect(m.acks).toBe(0);
    expect(m.naks).toEqual([5]);
  });

  it("records permanent failures and incomplete content visibly, then acknowledges", async () => {
    const { port } = index([new IndexingError("rejected", false)]);
    const { event, bytes } = await eventBytes();
    const m = msg(bytes);
    expect(await consumer(port).handle(m)).toEqual({ action: "ack", outcome: "failed" });
    expect(operations.claim(`index:${event.subject}:${event.id}`, "x", 1_000)).toEqual({
      kind: "exhausted",
      errorCode: "rejected",
    });

    const partial = await eventBytes(record(false), "substack/example-pub/a-post/partial.json");
    const p = msg(partial.bytes);
    expect(await consumer(index().port).handle(p)).toEqual({
      action: "ack",
      outcome: "incomplete",
    });
    expect(
      operations.claim(`index:${partial.event.subject}:${partial.event.id}`, "x", 1_000),
    ).toEqual({
      kind: "exhausted",
      errorCode: "incomplete-content",
    });
  });

  it("terminates malformed messages", async () => {
    const m = msg(new TextEncoder().encode('{"not":"an event"}'));
    expect(await consumer(index().port).handle(m)).toEqual({
      action: "term",
      reason: "invalid-event",
    });
    expect(m.terms).toBe(1);
  });
});

// Controlled handoff smoke test: real JetStream and Elasticsearch, synthetic data.
const natsUrl = process.env.STEELE_TEST_NATS_URL;
const esUrl = process.env.STEELE_TEST_ES_URL;
describe.skipIf(!natsUrl || !esUrl)("indexing consumer smoke test", () => {
  it("indexes a saved text-ready event delivered twice once, and recovers from an index outage", async () => {
    const { NatsController } = await import("../../src/controllers/nats.js");
    const { ElasticsearchController } = await import("../../src/controllers/elasticsearch.js");
    const { provisionDiscoveryStream, provisionDurableConsumer } =
      await import("../../src/controllers/nats-provision.js");
    const { Client } = await import("@elastic/elasticsearch");
    const run = Date.now().toString(36);
    const stream = `STEELE_INDEX_${run}`;
    const subject = `steele.test.${run}.content.extracted`;
    const alias = `steele-source-text-test-${run}`;
    const nats = new NatsController(natsUrl!);
    const es = new ElasticsearchController(esUrl!);
    const admin = new Client({ node: esUrl! });
    await nats.connect("steele-index-smoke");
    try {
      await es.provisionIndex(alias, FULLTEXT_INDEX_MAPPING);
      await provisionDiscoveryStream(nats, { name: stream, subjects: [subject] });
      await provisionDurableConsumer(nats, {
        stream,
        name: "indexer",
        filterSubject: subject,
        ackWaitMs: 5_000,
      });

      const { event, bytes } = await eventBytes();
      // The same saved event is delivered twice (two distinct broker messages).
      await nats.publish(subject, bytes, { msgId: `${event.id}-1` });
      await nats.publish(subject, bytes, { msgId: `${event.id}-2` });

      // First index call fails as an outage; later calls go through.
      let outage = true;
      const port: FulltextIndexPort = {
        indexDocument: async (i, id, d, o) => {
          if (outage) {
            outage = false;
            throw new IndexingError("unavailable", true);
          }
          return es.indexDocument(i, id, d, { ...o, refresh: "wait_for" });
        },
      };
      const decisions: string[] = [];
      const worker = new IndexingConsumer({
        artifacts,
        index: port,
        indexName: alias,
        operations,
        owner: "smoke",
        retryDelayMs: 200,
        onDecision: (d) => decisions.push(d.action === "ack" ? `ack:${d.outcome}` : d.action),
      });
      const abort = new AbortController();
      const consuming = nats.consume(
        stream,
        "indexer",
        async (m) => {
          await worker.handle(m);
          if (decisions.filter((d) => d.startsWith("ack")).length >= 2) abort.abort();
        },
        abort.signal,
      );
      await Promise.race([
        consuming,
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 20_000)),
      ]);
      expect(decisions[0]).toBe("nak");
      expect(decisions.filter((d) => d === "ack:indexed")).toHaveLength(1);
      expect(decisions.filter((d) => d === "ack:stale")).toHaveLength(1);
      expect((await admin.count({ index: alias })).count).toBe(1);
      const hit = await admin.search({ index: alias, query: { match: { text: "retained" } } });
      expect(hit.hits.hits).toHaveLength(1);
      expect(TEXT_READY_SUBJECT).toBe("steele.v1.content.extracted");
    } finally {
      const jsm = await nats.manager().catch(() => undefined);
      await jsm?.streams.delete(stream).catch(() => undefined);
      await admin.indices.delete({ index: `${alias}-000001` }).catch(() => undefined);
      await admin.close();
      await es.close();
      await nats.close();
    }
  }, 60_000);
});

void FULLTEXT_INDEX_V1;
