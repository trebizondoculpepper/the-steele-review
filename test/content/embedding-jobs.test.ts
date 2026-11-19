import { describe, expect, it } from "vite-plus/test";
import {
  EmbeddingPlanError,
  batchJobs,
  partitionReusable,
  planEmbeddingJobs,
} from "../../src/content/embedding-jobs.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { DEFAULT_CHUNKING } from "../../src/content/passage-vectors.js";
import type { EmbeddingModel } from "../../src/controllers/embedding.js";

const MODEL: EmbeddingModel = {
  provider: "fake",
  model: "embed-small",
  version: "1",
  dimensions: 4,
};
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
const plan = (overrides: Record<string, unknown> = {}) =>
  planEmbeddingJobs({
    sourceId: "substack/example-pub/a-post",
    text: TEXT,
    sourceVersion: sourceVersionFor(TEXT),
    artifact,
    model: MODEL,
    chunking: CHUNKING,
    ...overrides,
  });

describe("planEmbeddingJobs", () => {
  it("lists ordered jobs keeping original source spans", () => {
    const p = plan();
    expect(p.jobs.length).toBeGreaterThan(1);
    expect(p.jobs.map((j) => j.position)).toEqual(p.jobs.map((_, i) => i));
    for (const job of p.jobs) {
      expect(TEXT.slice(job.passage.start, job.passage.end)).toBe(job.passage.text);
      expect(job.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(p.vectorSpace).toBe("fake/embed-small@1#4");
  });

  it("is deterministic for repeated input", () => {
    const a = plan();
    const b = plan();
    expect(b.jobs.map((j) => [j.jobKey, j.reuseKey])).toEqual(
      a.jobs.map((j) => [j.jobKey, j.reuseKey]),
    );
    expect(b.indexName).toBe(a.indexName);
  });

  it("creates new jobs and keys when the model or dimensions change", () => {
    const base = plan();
    for (const model of [
      { ...MODEL, version: "2" },
      { ...MODEL, dimensions: 8 },
    ]) {
      const changed = plan({ model });
      expect(changed.indexName).not.toBe(base.indexName);
      changed.jobs.forEach((job, i) => {
        expect(job.jobKey).not.toBe(base.jobs[i]!.jobKey);
        expect(job.reuseKey).not.toBe(base.jobs[i]!.reuseKey);
      });
    }
  });

  it("creates new jobs when the splitter changes", () => {
    const base = plan();
    const resized = plan({ chunking: { ...CHUNKING, maxChars: 120 } });
    expect(resized.indexName).not.toBe(base.indexName);
    expect(resized.jobs.length).not.toBe(base.jobs.length);
    // A splitter version this code cannot run is refused rather than mislabelled.
    expect(() =>
      plan({ chunking: { ...CHUNKING, splitterVersion: CHUNKING.splitterVersion + 1 } }),
    ).toThrow("unsupported-splitter-version");
  });

  it("reuses results for identical passage text across sources but not across sources' job keys", () => {
    const other = plan({ sourceId: "substack/example-pub/copy" });
    const base = plan();
    expect(other.jobs[0]!.reuseKey).toBe(base.jobs[0]!.reuseKey);
    expect(other.jobs[0]!.jobKey).not.toBe(base.jobs[0]!.jobKey);
  });

  it("plans no jobs for empty text", () => {
    expect(plan({ text: "   ", sourceVersion: sourceVersionFor("   ") }).jobs).toEqual([]);
  });

  it("refuses plans beyond the job bound and invalid models", () => {
    expect(() => plan({ maxJobs: 1 })).toThrow(EmbeddingPlanError);
    expect(() => plan({ model: { ...MODEL, dimensions: 0 } })).toThrow("invalid-model");
  });
});

describe("partitionReusable and batchJobs", () => {
  it("separates jobs with known results from those needing a provider call", () => {
    const p = plan();
    const known = new Set([p.jobs[0]!.reuseKey]);
    const { reusable, toEmbed } = partitionReusable(p, known);
    expect(reusable.map((j) => j.position)).toEqual([0]);
    expect(toEmbed.map((j) => j.position)).toEqual(p.jobs.slice(1).map((j) => j.position));
  });

  it("batches in order", () => {
    const p = plan();
    const batches = batchJobs(p.jobs, 2);
    expect(batches.flat()).toEqual(p.jobs);
    expect(batches.every((b) => b.length <= 2)).toBe(true);
  });
});
