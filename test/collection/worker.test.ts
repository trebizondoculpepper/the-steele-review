import { TranscriptionError } from "../../src/transcription/adapter.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  CollectionStore,
  collectionArtifactPath,
  collectionKey,
  reingestKey,
} from "../../src/collection/collection-store.js";
import { requestReingest } from "../../src/collection/reingest.js";
import {
  CollectionWorker,
  type CollectorPort,
  type TranscriberPort,
} from "../../src/collection/worker.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import type { CollectionResult } from "../../src/controllers/substack/collect.js";
import { createDiscoveryEvent, serializeDiscoveryEvent } from "../../src/events/discovery-event.js";
import { parseTextReadyEvent } from "../../src/events/text-ready-event.js";
import {
  CAPTURED_CONTENT_SUBJECT,
  parseCapturedContentEvent,
} from "../../src/events/captured-content-event.js";
import type { SubstackItem } from "../../src/content/substack-item.js";
import { parseFeed } from "../../src/controllers/substack/rss.js";
import { SubstackContentCollector } from "../../src/controllers/substack/collect.js";
import { extractGroundedClaims } from "../../src/analysis/grounded-claims.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import type { ClaimOccurrence } from "../../src/analysis/claim-occurrence.js";
import { findSameSpeakerHistory } from "../../src/analysis/same-speaker-history.js";

const item: SubstackItem = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  title: "A synthetic post",
};
const provenance = {
  sourceUrl: item.url,
  acquiredAt: "2026-02-01T00:00:00.000Z",
  method: "supplied-transcript" as const,
};
const textResult = (text = "Synthetic transcript text."): CollectionResult => ({
  kind: "text",
  item,
  supplied: { transcript: [{ start: 0, end: 2, text }], transcriptDocument: "[]" },
  text,
  complete: true,
  provenance,
});

type Message = DeliveredMessage & { acked: number; naks: number[]; termed: number };
function message(reason: "live" | "backfill" = "backfill", data?: Uint8Array): Message {
  const m: Message = {
    data:
      data ??
      new TextEncoder().encode(serializeDiscoveryEvent(createDiscoveryEvent(item, { reason }))),
    deliveryCount: 1,
    acked: 0,
    naks: [],
    termed: 0,
    ack: async () => {
      m.acked++;
    },
    nak: (delay) => {
      m.naks.push(delay ?? 0);
    },
    term: () => {
      m.termed++;
    },
    working: () => {},
  };
  return m;
}

let dir: string;
let ops: OperationStore[];
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-worker-"));
  await mkdir(join(dir, "archive"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "test-archive" });
  await artifacts.initialise();
  ops = [];
});
afterEach(async () => {
  for (const o of ops) o.close();
  await rm(dir, { recursive: true, force: true });
});

function setup(options: {
  collect?: (call: number) => CollectionResult | Promise<CollectionResult>;
  transcriber?: TranscriberPort;
  publishFails?: number;
  owner?: string;
}) {
  const operations = new OperationStore({ path: join(dir, "state.sqlite") });
  ops.push(operations);
  const store = new CollectionStore(operations, artifacts);
  let calls = 0;
  const collector: CollectorPort = {
    collect: async () => (options.collect ?? (() => textResult()))(++calls),
  };
  const published: Array<{ subject: string; body: string; msgId: string }> = [];
  const captured: Array<{ subject: string; body: string; msgId: string }> = [];
  let failures = options.publishFails ?? 0;
  const worker = new CollectionWorker({
    store,
    operations,
    collector,
    transcriber: options.transcriber,
    publisher: {
      publish: async (subject, payload, { msgId }) => {
        if (failures-- > 0) throw new Error("broker down");
        // Text-ready events in `published`; the captured-content companion (#269) apart.
        (subject === CAPTURED_CONTENT_SUBJECT ? captured : published).push({
          subject,
          body: new TextDecoder().decode(payload),
          msgId,
        });
      },
    },
    owner: options.owner ?? "worker-1",
    retryDelayMs: 0,
  });
  return { worker, operations, store, published, captured, collectCalls: () => calls };
}

describe("CollectionWorker", () => {
  it("carries explicit bylines from discovery through capture and claims into same-speaker history", async () => {
    const posts = await parseFeed(
      `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>Synthetic</title>${["earlier", "current", "anonymous"]
        .map(
          (id, i) => `
      <item><title>${id}</title><link>https://example-pub.substack.com/p/${id}</link>
      <pubDate>${new Date(Date.UTC(2026, i, 1)).toUTCString()}</pubDate>
      ${i < 2 ? "<dc:creator>Dr Synthetic</dc:creator>" : ""}</item>`,
        )
        .join("")}
      </channel></rss>`,
      "example-pub",
    );
    const collector = new SubstackContentCollector({
      publicationUrl: "https://example-pub.substack.com/",
      fetch: (async (url) =>
        new Response(
          JSON.stringify({
            slug: new URL(String(url)).pathname.split("/").at(-1),
            audience: "everyone",
            body_html: "<p>Towers control the weather.</p>",
          }),
        )) as typeof fetch,
    });
    const { worker, store } = setup({ collect: (call) => collector.collect(posts[call - 1]) });
    await mkdir(join(dir, "content"));
    const content = new GitArtifactStore({ repoPath: join(dir, "content"), repository: "content" });
    await content.initialise();
    const indexed: ClaimOccurrence[] = [];
    const provider = {
      modelVersion: "fixture",
      complete: async () =>
        JSON.stringify({
          claims: [
            {
              statement: "Towers control the weather.",
              passage: "Towers control the weather.",
              claimType: "factual",
              kind: "assertion",
              speaker: { kind: "author-voice" },
              qualifiers: [],
              entities: [],
              dates: [],
              themeIds: ["weather"],
            },
          ],
        }),
    };
    for (const post of posts) {
      const event = createDiscoveryEvent(post, { reason: "live" });
      expect(
        await worker.handle(
          message("live", new TextEncoder().encode(serializeDiscoveryEvent(event))),
        ),
      ).toBe("collected");
      const saved = (await store.existing(post))!;
      expect(saved.record.item.author).toBe(post.author);
      const result = await extractGroundedClaims({
        provider,
        artifacts: content,
        themes: [{ id: "weather", name: "Weather", definition: "Weather narratives" }],
        index: {
          indexDocument: async (_index, _id, doc) => {
            indexed.push(doc as ClaimOccurrence);
          },
        },
        source: {
          text: saved.record.text,
          sourceVersion: sourceVersionFor(saved.record.text),
          artifact: {
            repository: saved.artifact.repository,
            commit: saved.artifact.commit,
            path: saved.artifact.path,
            hash: `sha256:${saved.artifact.sha256}`,
          },
          publicationId: post.publicationId,
          postId: post.postId,
          url: post.url,
          publishedAt: post.publishedAt,
          author: saved.record.item.author,
        },
      });
      expect(result.status).toBe("extracted");
    }
    const search = {
      search: async () =>
        indexed.map((occurrence) => ({ id: occurrence.occurrenceId, source: occurrence })),
    };
    const history = await findSameSpeakerHistory({ search, occurrence: indexed[1], provider });
    expect(history.outcome).toBe("matches");
    expect(history.matches[0]).toMatchObject({
      postId: "earlier",
      speaker: { name: "Dr Synthetic", basis: "post-author" },
    });
    expect(indexed[2].publisher.author).toBeUndefined();
    expect(
      (await findSameSpeakerHistory({ search, occurrence: indexed[2], provider })).outcome,
    ).toBe("speaker-unverified");
  });
  it("collects, commits, acknowledges and hands off a text-ready event", async () => {
    const { worker, published, captured } = setup({});
    const m = message("backfill");
    expect(await worker.handle(m)).toBe("collected");
    // The source-neutral captured-content event is committed with the text-ready one (#269).
    expect(captured).toHaveLength(1);
    const item = parseCapturedContentEvent(captured[0]!.body);
    expect(item).toMatchObject({
      source: { namespace: "substack/example-pub", kind: "substack" },
      itemId: "a-post",
      ingestionReason: "backfill",
    });
    expect(m.acked).toBe(1);
    expect(published).toHaveLength(1);
    const event = parseTextReadyEvent(published[0]!.body);
    expect(event.data).toMatchObject({
      postId: "a-post",
      ingestionReason: "backfill",
      acquisitionMethod: "supplied-transcript",
      complete: true,
    });
    expect(published[0]!.msgId).toBe(event.id);
    const stored = JSON.parse(
      await artifacts.read({
        repository: event.data!.artifact.repository,
        commit: event.data!.artifact.commit,
        path: event.data!.artifact.path,
        sha256: event.data!.artifact.hash.slice(7),
      }),
    );
    expect(stored).toMatchObject({
      ingestionReason: "backfill",
      text: "Synthetic transcript text.",
    });
  });

  it("reuses the completed result on duplicate delivery without collecting again", async () => {
    const { worker, collectCalls, published } = setup({});
    await worker.handle(message());
    const duplicate = message("live");
    expect(await worker.handle(duplicate)).toBe("already-collected");
    expect(duplicate.acked).toBe(1);
    expect(collectCalls()).toBe(1);
    expect(published).toHaveLength(1);
  });

  it("defers while another worker holds the claim", async () => {
    const a = setup({ owner: "worker-a" });
    const b = setup({ owner: "worker-b" });
    a.operations.claim(collectionKey(item), "worker-a", 60_000);
    const m = message();
    expect(await b.worker.handle(m)).toBe("busy");
    expect(m.naks).toHaveLength(1);
    expect(m.acked).toBe(0);
  });

  it("recovers when the worker crashed after committing but before acknowledging", async () => {
    // First worker: commit succeeds, then the process dies (ack never sent, lease still live).
    const first = setup({ owner: "worker-a" });
    const claim = first.operations.claim(collectionKey(item), "worker-a", 1);
    if (claim.kind !== "claimed") throw new Error("expected claim");
    await first.store.commit(
      claim.claim,
      {
        item,
        ingestionReason: "backfill",
        text: "From the crashed attempt.",
        complete: true,
        supplied: {},
        provenance,
      },
      () => [],
    );
    // Redelivery to a restarted worker.
    const restarted = setup({ owner: "worker-b" });
    const m = message();
    expect(await restarted.worker.handle(m)).toBe("already-collected");
    expect(m.acked).toBe(1);
    expect(restarted.collectCalls()).toBe(0);
  });

  it("finishes from a committed artifact after a crash on a non-final attempt, without refetching", async () => {
    const first = setup({ owner: "worker-a" });
    const claim = first.operations.claim(collectionKey(item), "worker-a", 1, 5);
    if (claim.kind !== "claimed") throw new Error("expected claim");
    // Crash after the Git commit but before SQLite completion.
    await artifacts.write(
      "substack/example-pub/a-post/collected.json",
      `${JSON.stringify(
        {
          item,
          ingestionReason: "backfill",
          text: "Committed before the crash.",
          complete: false,
          supplied: {},
          provenance: { ...provenance, method: "article-html" },
        },
        null,
        2,
      )}\n`,
    );
    await new Promise((r) => setTimeout(r, 5)); // lease expires
    const restarted = setup({ owner: "worker-b" });
    const m = message("live");
    expect(await restarted.worker.handle(m)).toBe("already-collected");
    expect(restarted.collectCalls()).toBe(0);
    expect(m.acked).toBe(1);
    const event = parseTextReadyEvent(restarted.published[0]!.body);
    // Metadata comes from the retained record, not the redelivered event or a placeholder.
    expect(event.data).toMatchObject({
      ingestionReason: "backfill",
      acquisitionMethod: "article-html",
      complete: false,
    });
  });

  it("labels an exhausted-orphan reconciliation from the retained record", async () => {
    const first = setup({ owner: "worker-a" });
    const claim = first.operations.claim(collectionKey(item), "worker-a", 1, 1);
    if (claim.kind !== "claimed") throw new Error("expected claim");
    await artifacts.write(
      "substack/example-pub/a-post/collected.json",
      `${JSON.stringify(
        {
          item,
          ingestionReason: "live",
          text: "Partial.",
          complete: false,
          supplied: {},
          provenance: { ...provenance, method: "supplied-transcript" },
        },
        null,
        2,
      )}\n`,
    );
    first.operations.fail(claim.claim, "crashed", true); // final attempt used
    const restarted = setup({ owner: "worker-b" });
    expect(await restarted.worker.handle(message("backfill"))).toBe("already-collected");
    const event = parseTextReadyEvent(restarted.published[0]!.body);
    expect(event.data).toMatchObject({
      ingestionReason: "live",
      acquisitionMethod: "supplied-transcript",
      complete: false,
    });
  });

  it("retries instead of refetching when the archive lookup fails", async () => {
    const { worker, store, collectCalls } = setup({});
    store.existing = async () => {
      throw new Error("git read failed");
    };
    const m = message();
    expect(await worker.handle(m)).toBe("retry");
    expect(m.naks).toHaveLength(1);
    expect(collectCalls()).toBe(0);
  });

  it("records unavailable content visibly and does not retry it", async () => {
    const { worker, operations } = setup({
      collect: () => ({ kind: "unavailable", item, reason: "restricted" }),
    });
    const m = message();
    expect(await worker.handle(m)).toBe("unavailable");
    expect(m.acked).toBe(1);
    expect(operations.claim(collectionKey(item), "x", 1_000)).toEqual({
      kind: "exhausted",
      errorCode: "unavailable:restricted",
    });
  });

  it("retries transient failures with redelivery", async () => {
    const { worker } = setup({
      collect: (n) =>
        n === 1 ? { kind: "transient-failure", item, reason: "HTTP 503" } : textResult(),
    });
    const first = message();
    expect(await worker.handle(first)).toBe("retry");
    expect(first.naks).toHaveLength(1);
    expect(first.acked).toBe(0);
    expect(await worker.handle(message())).toBe("collected");
  });

  it("keeps the supplied-transcript path working without a transcription provider", async () => {
    const needsAudio: CollectionResult = {
      kind: "transcription-required",
      item,
      media: { kind: "audio", url: "https://media.test/a.mp3" },
      provenance: { sourceUrl: item.url, acquiredAt: provenance.acquiredAt },
    };
    const { worker, operations } = setup({ collect: () => needsAudio });
    const m = message();
    expect(await worker.handle(m)).toBe("transcription-unavailable");
    expect(m.acked).toBe(1);
    expect(operations.claim(collectionKey(item), "x", 1_000).kind).toBe("exhausted");
  });

  it("records no intelligible speech as a durable transcription-unusable outcome (#234)", async () => {
    const needsAudio: CollectionResult = {
      kind: "transcription-required",
      item,
      media: { kind: "audio", url: "https://media.test/a.mp3" },
      provenance: { sourceUrl: item.url, acquiredAt: provenance.acquiredAt },
    };
    const transcriber: TranscriberPort = {
      transcribe: async () => {
        throw new TranscriptionError("empty-transcript", false);
      },
    };
    const { worker, operations } = setup({ collect: () => needsAudio, transcriber });
    const m = message();
    expect(await worker.handle(m)).toBe("transcription-unavailable");
    expect(m.acked).toBe(1);
    expect(m.naks).toHaveLength(0);
    expect(operations.claim(collectionKey(item), "x", 1_000)).toEqual({
      kind: "exhausted",
      errorCode: "transcription-unusable",
    });
  });

  it("transcribes audio, stores machine-transcript provenance and deletes media after commit", async () => {
    let cleaned = 0;
    const transcriber: TranscriberPort = {
      transcribe: async () => ({
        transcript: {
          text: "Machine words.",
          segments: [{ text: "Machine words.", start: 0, end: 1 }],
          timestamped: true,
          provider: "fake",
          model: "fake-1",
          mediaKind: "audio",
          confidence: 0.82,
          complete: true,
          machineGenerated: true,
        },
        cleanup: async () => {
          cleaned++;
        },
      }),
    };
    const { worker, published } = setup({
      transcriber,
      collect: () => ({
        kind: "transcription-required",
        item,
        media: { kind: "audio", url: "https://media.test/a.mp3" },
        articleText: "Description.",
        provenance: { sourceUrl: item.url, acquiredAt: provenance.acquiredAt },
      }),
    });
    expect(await worker.handle(message())).toBe("collected");
    expect(cleaned).toBe(1);
    expect(parseTextReadyEvent(published[0]!.body).data?.acquisitionMethod).toBe(
      "machine-transcript",
    );
    const ref = parseTextReadyEvent(published[0]!.body).data!.artifact;
    const stored = JSON.parse(
      await artifacts.read({
        repository: ref.repository,
        commit: ref.commit,
        path: ref.path,
        sha256: ref.hash.slice(7),
      }),
    );
    expect(stored.provenance).toMatchObject({
      method: "machine-transcript",
      transcriptionProvider: "fake",
      transcriptionModel: "fake-1",
      transcriptionConfidence: 0.82,
      transcriptionComplete: true,
      machineGenerated: true,
    });
  });

  it("reports failed transcription and frees media", async () => {
    const transcriber: TranscriberPort = {
      transcribe: async () => {
        throw Object.assign(new Error("provider-failed"), { retryable: true });
      },
    };
    const { worker } = setup({
      transcriber,
      collect: () => ({
        kind: "transcription-required",
        item,
        media: { kind: "audio", url: "https://media.test/a.mp3" },
        provenance: { sourceUrl: item.url, acquiredAt: provenance.acquiredAt },
      }),
    });
    const m = message();
    expect(await worker.handle(m)).toBe("retry");
    expect(m.naks).toHaveLength(1);
  });

  it("keeps the available timings of a partly timed machine transcript", async () => {
    const transcriber: TranscriberPort = {
      transcribe: async () => ({
        transcript: {
          text: "First. Second.",
          segments: [{ text: "First.", start: 0, end: 1.5 }, { text: "Second." }],
          timestamped: false,
          provider: "fake",
          model: "fake-1",
          mediaKind: "audio",
          complete: true,
          machineGenerated: true,
        },
        cleanup: async () => {},
      }),
    };
    const { worker, published } = setup({
      transcriber,
      collect: () => ({
        kind: "transcription-required",
        item,
        media: { kind: "audio", url: "https://media.test/a.mp3" },
        provenance: { sourceUrl: item.url, acquiredAt: provenance.acquiredAt },
      }),
    });
    expect(await worker.handle(message())).toBe("collected");
    const ref = parseTextReadyEvent(published[0]!.body).data!.artifact;
    const stored = JSON.parse(
      await artifacts.read({
        repository: ref.repository,
        commit: ref.commit,
        path: ref.path,
        sha256: ref.hash.slice(7),
      }),
    );
    expect(stored.supplied.transcript).toEqual([
      { start: 0, end: 1.5, text: "First." },
      { text: "Second." },
    ]);
  });

  it("sends broker heartbeats within the configured interval even with a long lease", async () => {
    let working = 0;
    let release: () => void = () => {};
    const slow = setup({
      collect: async () => {
        await new Promise<void>((r) => (release = r));
        return textResult();
      },
    });
    Object.assign(slow.worker as unknown as { leaseMs: number; heartbeatMs: number }, {
      leaseMs: 30 * 60 * 1000,
      heartbeatMs: 1_000,
    });
    const m = message();
    m.working = () => {
      working++;
    };
    const pending = slow.worker.handle(m);
    await new Promise((r) => setTimeout(r, 1_300));
    expect(working).toBeGreaterThan(0);
    release();
    await pending;
  }, 10_000);

  it("keeps cancelled transcription retryable", async () => {
    const transcriber: TranscriberPort = {
      transcribe: async () => {
        throw Object.assign(new Error("cancelled"), { reason: "cancelled", retryable: false });
      },
    };
    const { worker, operations } = setup({
      transcriber,
      collect: () => ({
        kind: "transcription-required",
        item,
        media: { kind: "audio", url: "https://media.test/a.mp3" },
        provenance: { sourceUrl: item.url, acquiredAt: provenance.acquiredAt },
      }),
    });
    const m = message();
    expect(await worker.handle(m)).toBe("retry");
    expect(m.naks).toHaveLength(1);
    expect(operations.claim(collectionKey(item), "next", 1_000).kind).toBe("claimed");
  });

  it("renews the lease during slow acquisition so another worker cannot claim the post", async () => {
    let working = 0;
    let release: () => void = () => {};
    const slow = setup({
      owner: "worker-slow",
      collect: async () => {
        await new Promise<void>((r) => (release = r));
        return textResult();
      },
    });
    (slow.worker as unknown as { leaseMs: number }).leaseMs = 1_500;
    const m = message();
    m.working = () => {
      working++;
    };
    const pending = slow.worker.handle(m);
    await new Promise((r) => setTimeout(r, 2_500)); // longer than the original lease
    const other = setup({ owner: "worker-other" });
    expect(other.operations.claim(collectionKey(item), "worker-other", 1_000).kind).toBe("busy");
    expect(working).toBeGreaterThan(0);
    release();
    expect(await pending).toBe("collected");
  }, 10_000);

  it("keeps the handoff pending when publishing fails, then retries with the same event ID", async () => {
    const { worker, operations, published } = setup({ publishFails: 1 });
    const m = message();
    expect(await worker.handle(m)).toBe("collected");
    expect(m.acked).toBe(1); // input acknowledged: state is durable
    expect(published).toHaveLength(0);
    const [pending] = operations.duePendingEvents();
    expect(pending).toBeDefined();
    expect(await worker.dispatchPending()).toBe(1);
    expect(published[0]!.msgId).toBe(pending!.eventId);
    expect(operations.duePendingEvents()).toHaveLength(0);
  });

  it("never publishes other stages' events from the shared outbox", async () => {
    const { worker, operations, published } = setup({});
    operations.reconcileCompleted("analysed:pub/p:x", {}, [
      { eventId: "analysed-x", subject: "steele.v1.post.analysed", payload: "{}" },
    ]);
    expect(await worker.dispatchPending()).toBe(0);
    expect(published).toHaveLength(0);
    expect(operations.pendingEventStatus("analysed-x")).toBe("pending");
  });

  it("terminates malformed events without touching state", async () => {
    const { worker, collectCalls } = setup({});
    const m = message("live", new TextEncoder().encode('{"not":"an event"}'));
    expect(await worker.handle(m)).toBe("invalid-event");
    expect(m.termed).toBe(1);
    expect(collectCalls()).toBe(0);
  });
});

// Controlled integration test with a disposable JetStream server
// (scripts/nats-test-server.sh) and real Git and SQLite state.
const natsUrl = process.env.STEELE_TEST_NATS_URL;
describe.skipIf(!natsUrl)("CollectionWorker with JetStream", () => {
  it("consumes durably, survives a crash before ack and hands off exactly one text-ready event", async () => {
    const { NatsController } = await import("../../src/controllers/nats.js");
    const { provisionDiscoveryStream, provisionDurableConsumer } =
      await import("../../src/controllers/nats-provision.js");
    const { TEXT_READY_SUBJECT } = await import("../../src/events/text-ready-event.js");
    const run = Date.now().toString(36);
    const stream = `STEELE_WORKER_${run}`;
    const discoverySubject = `steele.test.${run}.source.detected`;
    const readySubject = `steele.test.${run}.content.extracted`;
    const nats = new NatsController(natsUrl!);
    await nats.connect("steele-worker-test");
    try {
      await provisionDiscoveryStream(nats, {
        name: stream,
        subjects: [discoverySubject, readySubject],
      });
      await provisionDurableConsumer(nats, {
        stream,
        name: "collector",
        filterSubject: discoverySubject,
        ackWaitMs: 2_000,
      });
      // Duplicate discovery of the same post: one live, one backfill.
      for (const reason of ["live", "backfill"] as const) {
        const event = createDiscoveryEvent(item, { reason });
        await nats.publish(
          discoverySubject,
          new TextEncoder().encode(serializeDiscoveryEvent(event)),
          {
            msgId: event.id,
          },
        );
      }
      const operations = new OperationStore({ path: join(dir, "state.sqlite") });
      ops.push(operations);
      const store = new CollectionStore(operations, artifacts);
      let collected = 0;
      let crashOnce = true;
      const worker = new CollectionWorker({
        store,
        operations,
        collector: { collect: async () => (collected++, textResult()) },
        publisher: {
          publish: (_subject, payload, { msgId }) =>
            nats.publish(readySubject, payload, { msgId, expectStream: stream }),
        },
        owner: "worker-it",
        leaseMs: 60_000,
        retryDelayMs: 100,
      });
      const outcomes: string[] = [];
      const abort = new AbortController();
      const consuming = nats.consume(
        stream,
        "collector",
        async (m) => {
          if (crashOnce) {
            // Simulate a crash after durable commit but before acknowledgment.
            crashOnce = false;
            const claim = operations.claim(
              (await import("../../src/collection/collection-store.js")).collectionKey(item),
              "worker-crashed",
              1,
            );
            if (claim.kind === "claimed") {
              await store.commit(
                claim.claim,
                {
                  item,
                  ingestionReason: "live",
                  text: "Crashed attempt.",
                  complete: true,
                  supplied: {},
                  provenance,
                },
                (ref) => [
                  {
                    eventId: `ready-${ref.commit}`,
                    subject: TEXT_READY_SUBJECT,
                    payload: "{}",
                  },
                ],
              );
            }
            throw new Error("process died before ack");
          }
          outcomes.push(await worker.handle(m));
          if (outcomes.length >= 2) abort.abort();
        },
        abort.signal,
      );
      await Promise.race([
        consuming,
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 20_000)),
      ]);
      expect(outcomes).toEqual(["already-collected", "already-collected"]);
      expect(collected).toBe(0);
      // A pre-aborted consume returns at once without taking deliveries.
      const done = new AbortController();
      done.abort();
      await nats.consume(
        stream,
        "collector",
        async () => {
          throw new Error("must not be called");
        },
        done.signal,
      );

      // An existing consumer with a weaker ack policy is refused, not reused.
      const jsmCheck = await nats.manager();
      const { AckPolicy } = await import("@nats-io/jetstream");
      await jsmCheck.consumers.add(stream, {
        durable_name: "ack-all",
        filter_subject: discoverySubject,
        ack_policy: AckPolicy.All,
      });
      await expect(
        provisionDurableConsumer(nats, {
          stream,
          name: "ack-all",
          filterSubject: discoverySubject,
        }),
      ).rejects.toThrow("ack policy");

      // The pending handoff recorded by the crashed attempt is dispatched exactly once.
      const jsm = await nats.manager();
      const info = await jsm.streams.info(stream, { subjects_filter: readySubject });
      expect(info.state.subjects?.[readySubject] ?? 0).toBe(1);
      await jsm.streams.delete(stream);
    } finally {
      await nats.close();
    }
  }, 30_000);
});

describe("single-item reingestion (#558)", () => {
  /** The pending reingestion event as the collector would receive it. */
  const delivered = (operations: OperationStore) => {
    const due = operations.duePendingEvents(10).filter((e) => e.eventId.startsWith("reingest-"));
    return message("backfill", new TextEncoder().encode(due[0]!.payload));
  };

  it("revises a previously collected record in place, keeping the old version", async () => {
    const first = setup({ collect: () => textResult("Original text.") });
    expect(await first.worker.handle(message())).toBe("collected");
    const before = (await artifacts.lookup(collectionArtifactPath(item)))!;

    // New provenance from the current processor; the text is unchanged.
    const second = setup({
      collect: () => ({
        ...textResult("Original text."),
        item: { ...item, author: "A Byline" },
      }),
    });
    expect(
      requestReingest({ operations: second.operations, item, requestId: "refresh-1" }),
    ).toMatchObject({
      outcome: "requested",
    });
    expect(await second.worker.handle(delivered(second.operations))).toBe("collected");

    const after = (await artifacts.lookup(collectionArtifactPath(item)))!;
    expect(after.path).toBe(before.path);
    expect(after.commit).not.toBe(before.commit);
    expect(after.sha256).not.toBe(before.sha256);
    // The new record carries the new byline; the old version still reads its bytes.
    expect(JSON.parse(await artifacts.read(after)).item.author).toBe("A Byline");
    const old = await artifacts.lookupAt(before.commit, before.path);
    expect(JSON.parse(old!.content).item.author).toBeUndefined();
    // Downstream handoff points at the new exact version.
    const capturedEvent = second.captured.find(
      (c) => JSON.parse(c.body).data?.artifact?.commit === after.commit,
    );
    expect(capturedEvent).toBeDefined();
  });

  it("does not repeat a request, and ordinary discovery stays idempotent", async () => {
    const first = setup({});
    await first.worker.handle(message());
    const second = setup({});
    requestReingest({ operations: second.operations, item, requestId: "refresh-2" });
    expect(
      requestReingest({ operations: second.operations, item, requestId: "refresh-2" }),
    ).toMatchObject({
      outcome: "already-requested",
    });
    const m = delivered(second.operations);
    await second.worker.handle(m);
    const calls = second.collectCalls();
    // Redelivery of the same request does no second fetch.
    expect(await second.worker.handle(m)).toBe("already-collected");
    expect(second.collectCalls()).toBe(calls);
    // An ordinary discovery duplicate does nothing at all.
    expect(await second.worker.handle(message("live"))).toBe("already-collected");
    expect(second.collectCalls()).toBe(calls);
    expect(second.operations.operationStatus(reingestKey(item, "refresh-2"))?.status).toBe(
      "completed",
    );
  });

  it("reuses an existing transcript instead of transcribing again", async () => {
    const first = setup({ collect: () => textResult("Spoken words.") });
    await first.worker.handle(message());
    let transcriptions = 0;
    const second = setup({
      collect: () =>
        ({
          kind: "transcription-required",
          item,
          articleText: "",
          media: { kind: "audio", url: "https://cdn.example/a.mp3", durationSeconds: 60 },
          provenance,
        }) as never,
      transcriber: {
        transcribe: async () => {
          transcriptions++;
          throw new Error("must not transcribe");
        },
      },
    });
    requestReingest({ operations: second.operations, item, requestId: "refresh-3" });
    expect(await second.worker.handle(delivered(second.operations))).toBe("collected");
    expect(transcriptions).toBe(0);
    const record = JSON.parse(
      await artifacts.read((await artifacts.lookup(collectionArtifactPath(item)))!),
    );
    expect(record.text).toBe("Spoken words.");
  });

  it("refuses to reingest a post that was never collected", async () => {
    const w = setup({});
    requestReingest({ operations: w.operations, item, requestId: "refresh-4" });
    expect(await w.worker.handle(delivered(w.operations))).toBe("unavailable");
    expect(await artifacts.lookup(collectionArtifactPath(item))).toBeUndefined();
  });
});
