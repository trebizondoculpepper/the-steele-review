import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
import {
  CONTENT_EMBEDDED_SUBJECT,
  EmbeddingConsumer,
  transcriptTimingsFor,
  MAX_PASSAGE_TIMINGS,
} from "../../src/content/embedding-consumer.js";
import type { VectorWriterPort } from "../../src/content/embedding-batch.js";
import { DEFAULT_CHUNKING } from "../../src/content/passage-vectors.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { EmbeddingController, type EmbeddingModel } from "../../src/controllers/embedding.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { createTextReadyEvent } from "../../src/events/text-ready-event.js";

const MODEL: EmbeddingModel = { provider: "fake", model: "toy", version: "1", dimensions: 3 };
const CHUNKING = { ...DEFAULT_CHUNKING, maxChars: 60, overlapChars: 0, minChars: 10 };
const TEXT =
  "The synthetic council raised fees by three percent. " +
  "A synthetic critic said the fees would harm residents. " +
  "Officials denied that any fee change had happened.";
const item = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  title: "A synthetic post",
  publishedAt: "2026-01-02T00:00:00Z",
};
const record = (complete = true): CollectionRecord => ({
  item,
  ingestionReason: "backfill",
  text: TEXT,
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
  dir = await mkdtemp(join(tmpdir(), "steele-embed-consumer-"));
  await mkdir(join(dir, "archive"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "test-archive" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
async function message(r = record()) {
  const ref = await artifacts.write(
    `substack/example-pub/a-post/c-${n++}.json`,
    `${JSON.stringify(r)}\n`,
  );
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
  const m = {
    data: new TextEncoder().encode(JSON.stringify(event.toJSON())),
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

function setup(
  options: {
    model?: EmbeddingModel;
    maxJobs?: number;
    failCalls?: number[];
    abortAfter?: number;
  } = {},
) {
  const model = options.model ?? MODEL;
  let call = 0;
  const providerCalls: string[][] = [];
  const abort = new AbortController();
  const embedder = new EmbeddingController({
    provider: {
      model,
      maxBatchSize: 100,
      embed: async (texts) => {
        call++;
        providerCalls.push(texts);
        if (options.abortAfter !== undefined && call >= options.abortAfter) abort.abort();
        if (options.failCalls?.includes(call)) throw new Error("provider down");
        return texts.map(() => Array.from({ length: model.dimensions }, () => 0.5));
      },
    },
    maxAttempts: 1,
  });
  const written: string[] = [];
  const vectors: VectorWriterPort = { write: async (p) => void written.push(p.id) };
  const published: string[] = [];
  const consumer = new EmbeddingConsumer({
    artifacts,
    embedder,
    vectors,
    model,
    chunking: CHUNKING,
    operations,
    publisher: { publish: async (s) => void published.push(s) },
    owner: "embedder",
    maxJobs: options.maxJobs ?? 64,
    maxBatches: 1,
    retryDelayMs: 0,
  });
  return { consumer, providerCalls, written, published, abort };
}

describe("transcriptTimingsFor", () => {
  it("aligns timed segments to the record text and skips untimed ones", () => {
    const r = {
      ...record(),
      supplied: {
        transcript: [
          { start: 0, end: 4.5, text: "The synthetic council raised fees by three percent." },
          { text: "A synthetic critic said the fees would harm residents." },
          { start: 9, end: 12, text: "Officials denied that any fee change had happened." },
        ],
      },
    };
    const t = transcriptTimingsFor(r).transcriptTimings!;
    expect(t).toHaveLength(2);
    expect(TEXT.slice(t[1]!.start, t[1]!.end)).toBe(
      "Officials denied that any fee change had happened.",
    );
    expect(t[1]).toMatchObject({ startSeconds: 9, endSeconds: 12 });
    expect(transcriptTimingsFor(record())).toEqual({});
    // Article text before the transcript never matches, and zero-length segments are dropped.
    const combined = {
      ...record(),
      text: `Officials denied it. ${TEXT}`,
      supplied: {
        transcript: [
          { start: 0, end: 0, text: "The synthetic council raised fees by three percent." },
          { text: "A synthetic critic said the fees would harm residents." },
          { start: 9, end: 12, text: "Officials denied that any fee change had happened." },
        ],
      },
    };
    const c = transcriptTimingsFor(combined).transcriptTimings!;
    expect(c).toHaveLength(1);
    expect(c[0]!.start).toBe(combined.text.lastIndexOf("Officials denied that"));
  });
});

describe("dense transcript timings", () => {
  it("keeps short timed runs when the bound permits them", () => {
    const segs = [
      { start: 0, end: 1, text: "Hi." },
      { text: "untimed middle" },
      { start: 5, end: 6, text: "Yes." },
    ];
    const r = {
      ...record(),
      text: segs.map((x) => x.text).join(" "),
      supplied: { transcript: segs },
    };
    expect(transcriptTimingsFor(r).transcriptTimings).toHaveLength(2);
  });

  it("never merges across an untimed segment", () => {
    const segs = [
      { start: 0, end: 1, text: "a" },
      { text: "untimed words in the middle" },
      ...Array.from({ length: 10 }, (_, i) => ({ start: 10 + i, end: 10.5 + i, text: `word${i}` })),
    ];
    const r = {
      ...record(),
      text: segs.map((x) => x.text).join(" "),
      supplied: { transcript: segs },
    };
    const t = transcriptTimingsFor(r, 2_000).transcriptTimings ?? [];
    const untimed = r.text.indexOf("untimed");
    for (const x of t)
      expect(x.end <= untimed || x.start >= untimed + "untimed words in the middle".length).toBe(
        true,
      );
  });

  it("coalesces so no passage overlaps more than the stored bound", () => {
    const words = Array.from({ length: 3_000 }, (_, i) => ({
      start: i,
      end: i + 0.5,
      text: `w${i % 10}`,
    }));
    const r = {
      ...record(),
      text: words.map((w) => w.text).join(" "),
      supplied: { transcript: words },
    };
    const t = transcriptTimingsFor(r, 2_000).transcriptTimings!;
    const passage = { start: 0, end: 2_000 };
    expect(
      t.filter((x) => x.start < passage.end && x.end > passage.start).length,
    ).toBeLessThanOrEqual(MAX_PASSAGE_TIMINGS);
    expect(t[0]!.startSeconds).toBe(0);
    expect(t.at(-1)!.endSeconds).toBe(2_999.5);
  });
});

describe("EmbeddingConsumer", () => {
  it("embeds every passage, completes and hands off", async () => {
    const s = setup();
    const m = await message();
    expect(await s.consumer.handle(m)).toBe("embedded");
    expect(m.acks).toBe(1);
    expect(s.written.length).toBeGreaterThan(1);
    expect(s.published).toEqual([CONTENT_EMBEDDED_SUBJECT]);
  });

  it("treats a repeat event as already embedded without provider calls", async () => {
    const s = setup();
    await s.consumer.handle(await message());
    const again = await message();
    expect(await s.consumer.handle(again)).toBe("already-embedded");
    expect(again.acks).toBe(1);
    expect(s.providerCalls).toHaveLength(1);
  });

  it("continues a partially embedded source across deliveries without redoing work", async () => {
    const s = setup({ maxJobs: 1 });
    const m1 = await message();
    expect(await s.consumer.handle(m1)).toBe("in-progress");
    expect(m1.acks).toBe(0);
    expect(m1.naks).toHaveLength(1);
    let outcome = "in-progress";
    for (let i = 0; i < 10 && outcome !== "embedded"; i++)
      outcome = await s.consumer.handle(await message());
    expect(outcome).toBe("embedded");
    expect(new Set(s.written).size).toBe(s.written.length);
  });

  it("retries a partial provider failure without losing saved vectors", async () => {
    const s = setup({ failCalls: [1] });
    expect(await s.consumer.handle(await message())).toBe("in-progress");
    expect(s.written).toEqual([]);
    expect(await s.consumer.handle(await message())).toBe("embedded");
  });

  it("starts new work for a changed model", async () => {
    await setup().consumer.handle(await message());
    const changed = setup({ model: { ...MODEL, version: "2" } });
    expect(await changed.consumer.handle(await message())).toBe("embedded");
    expect(changed.providerCalls).toHaveLength(1);
  });

  it("keeps recorded progress when shut down mid-way", async () => {
    const s = setup({ maxJobs: 1, abortAfter: 1 });
    const m = await message();
    expect(await s.consumer.handle(m, s.abort.signal)).toBe("retry");
    expect(m.acks).toBe(0);
    const firstWritten = [...s.written];
    const resumed = setup();
    expect(await resumed.consumer.handle(await message())).toBe("embedded");
    // The vector saved before shutdown is not regenerated.
    for (const id of firstWritten) expect(resumed.written).not.toContain(id);
  });

  it("finishes a long source one job per delivery without exhausting attempts", async () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `Synthetic sentence number ${i} about council fees.`,
    ).join(" ");
    const s = setup({ maxJobs: 1 });
    let outcome = "";
    for (let i = 0; i < 200 && outcome !== "embedded"; i++) {
      outcome = await s.consumer.handle(await message({ ...record(), text: long }));
    }
    expect(outcome).toBe("embedded");
  }, 60_000);

  it("rejects an archive record that belongs to another post", async () => {
    const s = setup();
    const m = await message({
      ...record(),
      item: { ...item, postId: "other-post", url: "https://example-pub.substack.com/p/other-post" },
    });
    expect(await s.consumer.handle(m)).toBe("failed");
    expect(m.acks).toBe(1);
    expect(s.written).toEqual([]);
  });

  it("records a source too large to plan as a permanent failure", async () => {
    const huge = Array.from({ length: 7_000 }, (_, i) => `Sentence ${i} is here.`).join(" ");
    const s = setup();
    const m = await message({ ...record(), text: huge });
    expect(await s.consumer.handle(m)).toBe("failed");
    expect(m.acks).toBe(1);
    expect(s.providerCalls).toHaveLength(0);
  });

  it("records unreadable archive records instead of retrying forever", async () => {
    const s = setup();
    const ref = await artifacts.write("substack/example-pub/a-post/garbage.json", "not json\n");
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
      complete: true,
    });
    const m = await message();
    m.data = new TextEncoder().encode(JSON.stringify(event.toJSON()));
    expect(await s.consumer.handle(m)).toBe("failed");
    expect(m.acks).toBe(1);
    expect(m.naks).toEqual([]);
  });

  it("still embeds a complete record after an incomplete one with the same text", async () => {
    const s = setup();
    expect(await s.consumer.handle(await message(record(false)))).toBe("incomplete-source");
    expect(await s.consumer.handle(await message())).toBe("embedded");
  });

  it("records incomplete sources and terminates malformed events", async () => {
    const s = setup();
    const partial = await message(record(false));
    expect(await s.consumer.handle(partial)).toBe("incomplete-source");
    expect(partial.acks).toBe(1);
    const bad = await message();
    bad.data = new TextEncoder().encode("{}");
    expect(await s.consumer.handle(bad)).toBe("invalid-event");
    expect(bad.terms).toBe(1);
  });
});
