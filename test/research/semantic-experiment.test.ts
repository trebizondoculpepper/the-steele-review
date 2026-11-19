import { describe, expect, it } from "vite-plus/test";
import { EmbeddingController, type EmbeddingModel } from "../../src/controllers/embedding.js";
import {
  ExperimentBoundError,
  MAX_EXPERIMENT_SOURCES,
  cosine,
  keywordOverlap,
  renderExperimentReport,
  runSemanticExperiment,
  type ExperimentProbe,
  type ExperimentSource,
} from "../../src/research/semantic-experiment.js";

/**
 * Deterministic toy embedder: hashed bag of words. Like many real models it
 * barely registers "not", which is exactly the limitation the experiment
 * exists to expose. Results here describe this toy, never a real provider.
 */
const MODEL: EmbeddingModel = {
  provider: "toy",
  model: "bag-of-words",
  version: "1",
  dimensions: 64,
};
function toyController() {
  let calls = 0;
  const embedder = new EmbeddingController({
    provider: {
      model: MODEL,
      maxBatchSize: 500,
      embed: async (texts) => {
        calls++;
        return texts.map((t) => {
          const v = new Array<number>(64).fill(0);
          for (const w of t
            .toLowerCase()
            .split(/[^a-z]+/)
            .filter((x) => x.length > 2)) {
            let h = 0;
            for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 64;
            v[h]! += 1;
          }
          return v.some((x) => x) ? v : v.map((_, i) => (i === 0 ? 1 : 0));
        });
      },
    },
    maxAttempts: 1,
  });
  return { embedder, calls: () => calls };
}

const sources: ExperimentSource[] = [
  {
    sourceId: "substack/example-pub/towers",
    origin: "monitored",
    url: "https://example-pub.substack.com/p/towers",
    text: "Synthetic monitored text: the new towers emit dangerous radiation that harms residents.",
  },
  {
    sourceId: "research/tower-exposure",
    origin: "independent",
    url: "https://example.org/exposure",
    text: "Synthetic research text: measured exposure near the towers stayed far below safety limits.",
  },
  {
    sourceId: "substack/example-pub/gardening",
    origin: "monitored",
    text: "Synthetic monitored text about winter gardening and pruning roses.",
  },
];
const probes: ExperimentProbe[] = [
  { id: "claim", kind: "claim", text: "The towers emit dangerous radiation." },
  { id: "paraphrase", kind: "paraphrase", text: "Dangerous radiation is emitted by the towers." },
  { id: "negation", kind: "negation", text: "The towers do not emit dangerous radiation." },
  {
    id: "correction",
    kind: "correction",
    text: "Measured exposure near the towers stayed below safety limits.",
  },
];

describe("runSemanticExperiment", () => {
  it("ranks passages per probe with provenance, origin and both score kinds in one call", async () => {
    const { embedder, calls } = toyController();
    const report = await runSemanticExperiment({ sources, probes, embedder, topK: 2 });
    expect(calls()).toBe(1);
    expect(report).toMatchObject({ passages: 3, modelCalls: 1, model: { dimensions: 64 } });
    const claim = report.results.find((r) => r.probe.id === "claim")!;
    expect(claim.probe.synthetic).toBe(true);
    expect(claim.semantic[0]).toMatchObject({
      sourceId: "substack/example-pub/towers",
      origin: "monitored",
    });
    const top = claim.semantic[0]!;
    expect(sources[0]!.text.slice(top.start, top.end)).toBe(top.text);
    expect(claim.keyword).toHaveLength(2);
  });

  it("shows a negation sitting as close to the claim as a paraphrase does", async () => {
    const report = await runSemanticExperiment({
      sources,
      probes,
      embedder: toyController().embedder,
    });
    const sim = (a: string, b: string) =>
      report.probeSimilarity.find((s) => s.a === a && s.b === b)!.score;
    expect(sim("claim", "negation")).toBeGreaterThan(0.9);
    expect(sim("claim", "negation")).toBeGreaterThanOrEqual(sim("claim", "correction"));
  });

  it("enforces sample and probe bounds", async () => {
    const { embedder } = toyController();
    const many = Array.from({ length: MAX_EXPERIMENT_SOURCES + 1 }, (_, i) => ({
      ...sources[0]!,
      sourceId: `s${i}`,
    }));
    await expect(runSemanticExperiment({ sources: many, probes, embedder })).rejects.toThrow(
      ExperimentBoundError,
    );
    await expect(runSemanticExperiment({ sources, probes: [], embedder })).rejects.toThrow(
      ExperimentBoundError,
    );
    const dup = [probes[0]!, { ...probes[1]!, id: probes[0]!.id }];
    await expect(runSemanticExperiment({ sources, probes: dup, embedder })).rejects.toThrow(
      "unique",
    );
  });

  it("renders a report that labels probes, quotes passages and states the caveat", async () => {
    const text = renderExperimentReport(
      await runSemanticExperiment({ sources, probes, embedder: toyController().embedder }),
    );
    expect(text).toContain("[SYNTHETIC negation]");
    expect(text).toContain("[independent] research/tower-exposure https://example.org/exposure");
    expect(text).toContain("Similarity is not truth or entailment");
    expect(text).toContain("toy/bag-of-words@1#64");
  });
});

describe("scoring helpers", () => {
  it("computes cosine and keyword overlap", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(keywordOverlap("towers emit radiation", "radiation from towers")).toBeCloseTo(2 / 4);
  });
});
