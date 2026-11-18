import { describe, expect, it } from "vite-plus/test";
import {
  EmbeddingController,
  EmbeddingError,
  EmbeddingVectorSchema,
  VectorSpaceMismatchError,
  assertSameVectorSpace,
  inputHashFor,
  vectorSpaceId,
  type EmbeddingModel,
  type EmbeddingProvider,
} from "../../src/controllers/embedding.js";

const MODEL: EmbeddingModel = {
  provider: "fake",
  model: "embed-small",
  version: "1",
  dimensions: 3,
};
const input = (n: number) => {
  const text = `Synthetic passage ${n}.`;
  return { id: `passage-${n}`, text, inputHash: inputHashFor(text) };
};

function provider(
  behaviour: (texts: string[], call: number) => unknown = (texts) =>
    texts.map((_, i) => [i, 0.5, -1]),
  maxBatchSize = 100,
  model: EmbeddingModel = MODEL,
) {
  const batches: string[][] = [];
  const p: EmbeddingProvider = {
    model,
    maxBatchSize,
    async embed(texts) {
      batches.push(texts);
      return behaviour(texts, batches.length) as number[][];
    },
  };
  return { p, batches };
}
const noSleep = async () => {};

describe("EmbeddingController", () => {
  it("returns one validated vector per input with model identity", async () => {
    const { p } = provider();
    const vectors = await new EmbeddingController({ provider: p }).embed([input(1), input(2)]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual({
      inputId: "passage-1",
      inputHash: input(1).inputHash,
      model: MODEL,
      vectorSpace: "fake/embed-small@1#3",
      vector: [0, 0.5, -1],
    });
    for (const v of vectors) expect(EmbeddingVectorSchema.safeParse(v).success).toBe(true);
  });

  it("bounds batch size by configuration and provider limit", async () => {
    const { p, batches } = provider(undefined, 2);
    await new EmbeddingController({ provider: p, batchSize: 10 }).embed([1, 2, 3, 4, 5].map(input));
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it.each([
    ["wrong count", (t: string[]) => t.slice(1).map(() => [1, 2, 3])],
    ["wrong dimensions", (t: string[]) => t.map(() => [1, 2])],
    ["non-finite value", (t: string[]) => t.map(() => [1, Number.NaN, 3])],
    ["infinite value", (t: string[]) => t.map(() => [1, Infinity, 3])],
    ["not an array", () => ({ vectors: [] })],
  ])("rejects provider output with %s", async (_name, behaviour) => {
    const { p, batches } = provider(behaviour);
    await expect(
      new EmbeddingController({ provider: p, sleep: noSleep }).embed([input(1), input(2)]),
    ).rejects.toMatchObject({ reason: "invalid-output", retryable: false });
    expect(batches).toHaveLength(1);
  });

  it("verifies input hashes and bounds input size", async () => {
    const { p, batches } = provider();
    const controller = new EmbeddingController({ provider: p, maxInputChars: 30 });
    await expect(
      controller.embed([{ ...input(1), inputHash: inputHashFor("other") }]),
    ).rejects.toMatchObject({
      reason: "invalid-input",
    });
    const long = "x".repeat(31);
    await expect(
      controller.embed([{ id: "big", text: long, inputHash: inputHashFor(long) }]),
    ).rejects.toMatchObject({
      reason: "invalid-input",
    });
    expect(batches).toHaveLength(0);
  });

  it("retries provider failures a bounded number of times", async () => {
    const flaky = provider((texts, call) => {
      if (call < 3) throw new Error("503 from https://private.example key=secret");
      return texts.map(() => [1, 2, 3]);
    });
    const vectors = await new EmbeddingController({
      provider: flaky.p,
      maxAttempts: 3,
      sleep: noSleep,
    }).embed([input(1)]);
    expect(vectors).toHaveLength(1);
    expect(flaky.batches).toHaveLength(3);

    const down = provider(() => {
      throw new Error("down https://private.example");
    });
    const error = await new EmbeddingController({
      provider: down.p,
      maxAttempts: 2,
      sleep: noSleep,
    })
      .embed([input(1)])
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "provider-failed", retryable: true });
    expect(String(error)).not.toContain("private");
    expect(down.batches).toHaveLength(2);
  });

  it("reports completed vectors from earlier batches on a later failure", async () => {
    const { p } = provider((texts, call) => {
      if (call >= 2) throw new Error("down");
      return texts.map(() => [1, 2, 3]);
    }, 2);
    const error = (await new EmbeddingController({ provider: p, maxAttempts: 1 })
      .embed([1, 2, 3].map(input))
      .catch((e: unknown) => e)) as EmbeddingError;
    expect(error.completed.map((v) => v.inputId)).toEqual(["passage-1", "passage-2"]);
  });

  it("times out a hung provider and honours cancellation", async () => {
    const hung: EmbeddingProvider = {
      model: MODEL,
      maxBatchSize: 10,
      embed: () => new Promise(() => {}),
    };
    await expect(
      new EmbeddingController({ provider: hung, timeoutMs: 1_000, maxAttempts: 1 }).embed([
        input(1),
      ]),
    ).rejects.toMatchObject({ reason: "timeout" });
    const abort = new AbortController();
    const pending = new EmbeddingController({ provider: hung }).embed([input(1)], abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
  }, 5_000);

  it("rejects an invalid model description", () => {
    const { p } = provider(undefined, 10, { ...MODEL, dimensions: 0 });
    expect(() => new EmbeddingController({ provider: p })).toThrow();
  });
});

describe("vector spaces", () => {
  it("distinguishes models, versions and dimensions", () => {
    expect(vectorSpaceId(MODEL)).not.toBe(vectorSpaceId({ ...MODEL, version: "2" }));
    expect(vectorSpaceId(MODEL)).not.toBe(vectorSpaceId({ ...MODEL, dimensions: 4 }));
  });

  it("cannot be made to collide by separators inside model names or versions", () => {
    const a = vectorSpaceId({ ...MODEL, model: "a@1", version: "2" });
    const b = vectorSpaceId({ ...MODEL, model: "a", version: "1@2" });
    expect(a).not.toBe(b);
    expect(vectorSpaceId({ ...MODEL, model: "x/y" })).not.toBe(
      vectorSpaceId({ ...MODEL, provider: "fake", model: "x%2Fy" }),
    );
  });

  it("refuses to mix vectors from different spaces", async () => {
    const a = await new EmbeddingController({ provider: provider().p }).embed([input(1)]);
    const b = await new EmbeddingController({
      provider: provider(undefined, 10, { ...MODEL, version: "2" }).p,
    }).embed([input(1)]);
    expect(() => assertSameVectorSpace([...a, ...a])).not.toThrow();
    expect(() => assertSameVectorSpace([...a, ...b])).toThrow(VectorSpaceMismatchError);
  });

  it("rejects a stored vector whose space label does not match its model", () => {
    const stored = {
      inputId: "p",
      inputHash: input(1).inputHash,
      model: MODEL,
      vectorSpace: "fake/embed-small@2#3",
      vector: [1, 2, 3],
    };
    expect(EmbeddingVectorSchema.safeParse(stored).success).toBe(false);
  });
});
