import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { executeEmbeddingBatch, type VectorWriterPort } from "../../src/content/embedding-batch.js";
import { planEmbeddingJobs } from "../../src/content/embedding-jobs.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { DEFAULT_CHUNKING } from "../../src/content/passage-vectors.js";
import {
  EmbeddingController,
  type EmbeddingModel,
  type EmbeddingProvider,
} from "../../src/controllers/embedding.js";
import { OperationStore } from "../../src/controllers/operation-store.js";

const MODEL: EmbeddingModel = { provider: "fake", model: "toy", version: "1", dimensions: 3 };
const CHUNKING = { ...DEFAULT_CHUNKING, maxChars: 60, overlapChars: 0, minChars: 10 };
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
const plan = (sourceId = "substack/example-pub/a-post") =>
  planEmbeddingJobs({
    sourceId,
    text: TEXT,
    sourceVersion: sourceVersionFor(TEXT),
    artifact,
    model: MODEL,
    chunking: CHUNKING,
  });

let dir: string;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-embed-batch-"));
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

function provider(behaviour?: (texts: string[], call: number) => number[][]) {
  const calls: string[][] = [];
  const p: EmbeddingProvider = {
    model: MODEL,
    maxBatchSize: 100,
    embed: async (texts) => {
      calls.push(texts);
      return behaviour ? behaviour(texts, calls.length) : texts.map(() => [0.1, 0.2, 0.3]);
    },
  };
  return { embedder: new EmbeddingController({ provider: p, maxAttempts: 1 }), calls };
}

function writer(failFor: Set<string> = new Set()) {
  const written: string[] = [];
  const port: VectorWriterPort = {
    write: async (passage) => {
      if (failFor.has(passage.id)) throw new Error("index down");
      written.push(passage.id);
    },
  };
  return { port, written };
}

describe("executeEmbeddingBatch", () => {
  it("embeds and stores every job, then treats a repeat as already done", async () => {
    const p = plan();
    const { embedder, calls } = provider();
    const { port, written } = writer();
    const first = await executeEmbeddingBatch({
      plan: p,
      embedder,
      vectors: port,
      operations,
      owner: "w",
    });
    expect(first.embedded).toHaveLength(p.jobs.length);
    expect(written).toHaveLength(p.jobs.length);
    const again = await executeEmbeddingBatch({
      plan: p,
      embedder,
      vectors: port,
      operations,
      owner: "w",
    });
    expect(again.alreadyDone).toHaveLength(p.jobs.length);
    expect(calls).toHaveLength(1);
  });

  it("reuses stored vectors for identical passage text without a provider call", async () => {
    const { embedder, calls } = provider();
    await executeEmbeddingBatch({
      plan: plan(),
      embedder,
      vectors: writer().port,
      operations,
      owner: "w",
    });
    const copy = plan("substack/example-pub/copy");
    const { port, written } = writer();
    const result = await executeEmbeddingBatch({
      plan: copy,
      embedder,
      vectors: port,
      operations,
      owner: "w",
    });
    expect(result.reused).toHaveLength(copy.jobs.length);
    expect(result.embedded).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(written).toEqual(copy.jobs.map((j) => j.passage.id));
  });

  it("bounds the batch and reports the remaining jobs", async () => {
    const p = plan();
    const result = await executeEmbeddingBatch({
      plan: p,
      embedder: provider().embedder,
      vectors: writer().port,
      operations,
      owner: "w",
      maxJobs: 1,
    });
    expect(result.embedded).toHaveLength(1);
    expect(result.remaining).toEqual(p.jobs.slice(1).map((j) => j.jobKey));
  });

  it("keeps partial provider success and retries only the failed jobs", async () => {
    const p = plan();
    const small = new EmbeddingController({
      provider: {
        model: MODEL,
        maxBatchSize: 1,
        embed: (() => {
          let call = 0;
          return async (texts: string[]) => {
            call++;
            if (call === 2) throw new Error("provider down");
            return texts.map(() => [0.1, 0.2, 0.3]);
          };
        })(),
      },
      maxAttempts: 1,
    });
    const first = await executeEmbeddingBatch({
      plan: p,
      embedder: small,
      vectors: writer().port,
      operations,
      owner: "w",
    });
    expect(first.embedded).toHaveLength(1);
    expect(first.failed.map((f) => f.reason)).toEqual(
      Array(p.jobs.length - 1).fill("provider-failed"),
    );
    const { embedder, calls } = provider();
    const retry = await executeEmbeddingBatch({
      plan: p,
      embedder,
      vectors: writer().port,
      operations,
      owner: "w",
    });
    expect(retry.alreadyDone).toHaveLength(1);
    expect(retry.embedded).toHaveLength(p.jobs.length - 1);
    expect(calls[0]).toHaveLength(p.jobs.length - 1);
  });

  it("fails jobs whose vectors have the wrong dimensions without storing them", async () => {
    const p = plan();
    const { embedder } = provider((texts) => texts.map(() => [1, 2]));
    const { port, written } = writer();
    const result = await executeEmbeddingBatch({
      plan: p,
      embedder,
      vectors: port,
      operations,
      owner: "w",
    });
    expect(result.failed.every((f) => f.reason === "invalid-output" && !f.retryable)).toBe(true);
    expect(written).toEqual([]);
  });

  it("keeps cancelled jobs recoverable on the next invocation", async () => {
    const p = plan();
    const abort = new AbortController();
    abort.abort();
    const first = await executeEmbeddingBatch({
      plan: p,
      embedder: provider().embedder,
      vectors: writer().port,
      operations,
      owner: "w",
      signal: abort.signal,
    });
    expect(first.failed.every((f) => f.reason === "cancelled" && f.retryable)).toBe(true);
    const retry = await executeEmbeddingBatch({
      plan: p,
      embedder: provider().embedder,
      vectors: writer().port,
      operations,
      owner: "w",
    });
    expect(retry.embedded).toHaveLength(p.jobs.length);
  });

  it("reports exhausted jobs as terminal failures, not remaining work", async () => {
    const p = plan();
    const { embedder } = provider((texts) => texts.map(() => [1, 2]));
    await executeEmbeddingBatch({
      plan: p,
      embedder,
      vectors: writer().port,
      operations,
      owner: "w",
    });
    const again = await executeEmbeddingBatch({
      plan: p,
      embedder,
      vectors: writer().port,
      operations,
      owner: "w",
    });
    expect(again.remaining).toEqual([]);
    expect(again.failed.every((f) => f.reason === "exhausted" && !f.retryable)).toBe(true);
    expect(again.failed).toHaveLength(p.jobs.length);
  });

  it("isolates a rejected sub-batch so later sub-batches still embed", async () => {
    const p = plan();
    let call = 0;
    const { embedder } = provider((texts) => {
      call++;
      return texts.map(() => (call === 1 ? [1, 2] : [0.1, 0.2, 0.3]));
    });
    const result = await executeEmbeddingBatch({
      plan: p,
      embedder,
      vectors: writer().port,
      operations,
      owner: "w",
      embedBatchSize: 1,
    });
    expect(result.failed).toEqual([
      { jobKey: p.jobs[0]!.jobKey, reason: "invalid-output", retryable: false },
    ]);
    expect(result.embedded).toEqual(p.jobs.slice(1).map((j) => j.jobKey));
  });

  it("does not complete jobs whose lease was taken over mid-batch", async () => {
    const p = plan();
    const { embedder } = provider((texts) => {
      // While embedding, the 1 ms lease expires and another invocation reclaims the first job.
      const until = Date.now() + 5;
      while (Date.now() < until) {
        // wait for the lease to expire
      }
      expect(operations.claim(`embed-job:${p.jobs[0]!.jobKey}`, "other-worker", 60_000).kind).toBe(
        "claimed",
      );
      return texts.map(() => [0.1, 0.2, 0.3]);
    });
    const { port, written } = writer();
    const result = await executeEmbeddingBatch({
      plan: p,
      embedder,
      vectors: port,
      operations,
      owner: "w",
      leaseMs: 1,
    });
    expect(result.remaining).toContain(p.jobs[0]!.jobKey);
    expect(written).not.toContain(p.jobs[0]!.passage.id);
    expect(operations.claim(`embed-job:${p.jobs[0]!.jobKey}`, "x", 1_000).kind).toBe("busy");
  });

  it("reports persistence failures as retryable and keeps the vector for reuse", async () => {
    const p = plan();
    const { embedder, calls } = provider();
    const failing = writer(new Set([p.jobs[0]!.passage.id]));
    const first = await executeEmbeddingBatch({
      plan: p,
      embedder,
      vectors: failing.port,
      operations,
      owner: "w",
    });
    expect(first.failed).toEqual([
      { jobKey: p.jobs[0]!.jobKey, reason: "persistence-failed", retryable: true },
    ]);
    const retry = await executeEmbeddingBatch({
      plan: p,
      embedder,
      vectors: writer().port,
      operations,
      owner: "w",
    });
    expect(retry.reused).toEqual([p.jobs[0]!.jobKey]);
    expect(calls).toHaveLength(1);
  });
});
