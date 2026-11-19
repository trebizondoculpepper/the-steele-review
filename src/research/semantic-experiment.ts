import type { EmbeddingController } from "../controllers/embedding.js";
import { inputHashFor } from "../controllers/embedding.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import { splitPassages, type PassageOptions } from "../content/passages.js";

/**
 * Educational semantic-match experiment (#73). Not production retrieval
 * (#31 owns that) and not a verdict engine.
 *
 * Embeds a small, bounded sample of captured passages and a few labelled
 * synthetic probes (a claim, a paraphrase, a negation and a correction on
 * one topic), then reports the nearest passages for each probe by cosine
 * similarity next to a keyword-overlap ranking.
 *
 * What it demonstrates, rather than assumes: similarity is not truth or
 * entailment. A negation or a correction can sit as close to a false claim
 * as a paraphrase does. Ranked passages are candidates to read, never
 * statements labelled true.
 *
 * Probes are synthetic and labelled; they are embedded only in memory and
 * never written anywhere, so they cannot contaminate the evidence corpus.
 * Every passage keeps its origin (`monitored` publication text versus
 * `independent` research) and its source reference.
 */

export const MAX_EXPERIMENT_SOURCES = 20;
export const MAX_EXPERIMENT_PASSAGES = 200;
export const MAX_EXPERIMENT_PROBES = 12;

export type ProbeKind = "claim" | "paraphrase" | "negation" | "correction" | "unrelated";

export interface ExperimentSource {
  sourceId: string;
  /** `monitored` publication text, or `independent` research material. */
  origin: "monitored" | "independent";
  text: string;
  url?: string;
  publishedAt?: string;
}

export interface ExperimentProbe {
  id: string;
  kind: ProbeKind;
  text: string;
}

export interface ExperimentMatch {
  passageId: string;
  sourceId: string;
  origin: ExperimentSource["origin"];
  url?: string;
  start: number;
  end: number;
  text: string;
  score: number;
}

export interface ProbeResult {
  probe: ExperimentProbe & { synthetic: true };
  semantic: ExperimentMatch[];
  keyword: ExperimentMatch[];
}

export interface ExperimentReport {
  model: { vectorSpace: string; dimensions: number };
  chunking: { splitterVersion: number; maxChars: number; overlapChars: number };
  passages: number;
  modelCalls: number;
  results: ProbeResult[];
  /** Cosine similarity between probe pairs: how close opposite meanings sit. */
  probeSimilarity: Array<{ a: string; b: string; score: number }>;
}

export class ExperimentBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentBoundError";
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const tokens = (text: string) =>
  new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 2),
  );

/** Keyword overlap (Jaccard over word sets): a simple non-semantic baseline. */
export function keywordOverlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union ? shared / union : 0;
}

export async function runSemanticExperiment(input: {
  sources: ExperimentSource[];
  probes: ExperimentProbe[];
  embedder: Pick<EmbeddingController, "embed" | "model" | "vectorSpace">;
  chunking?: PassageOptions;
  topK?: number;
  signal?: AbortSignal;
}): Promise<ExperimentReport> {
  if (input.sources.length === 0 || input.sources.length > MAX_EXPERIMENT_SOURCES) {
    throw new ExperimentBoundError(`between 1 and ${MAX_EXPERIMENT_SOURCES} sources are required`);
  }
  if (input.probes.length === 0 || input.probes.length > MAX_EXPERIMENT_PROBES) {
    throw new ExperimentBoundError(`between 1 and ${MAX_EXPERIMENT_PROBES} probes are required`);
  }
  const topK = Math.max(1, Math.min(input.topK ?? 3, 10));

  const passages: Array<Omit<ExperimentMatch, "score">> = [];
  let chunking: ExperimentReport["chunking"] | undefined;
  for (const source of input.sources) {
    const set = splitPassages(
      {
        sourceId: source.sourceId,
        text: source.text,
        sourceVersion: sourceVersionFor(source.text),
        ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
      },
      input.chunking,
    );
    chunking ??= {
      splitterVersion: set.splitterVersion,
      maxChars: set.maxChars,
      overlapChars: set.overlapChars,
    };
    for (const p of set.passages) {
      passages.push({
        passageId: p.id,
        sourceId: source.sourceId,
        origin: source.origin,
        ...(source.url ? { url: source.url } : {}),
        start: p.start,
        end: p.end,
        text: p.text,
      });
    }
  }
  if (passages.length > MAX_EXPERIMENT_PASSAGES) {
    throw new ExperimentBoundError(
      `sample splits into ${passages.length} passages; at most ${MAX_EXPERIMENT_PASSAGES}`,
    );
  }

  // One bounded controller call: passages and probes together, in memory only.
  const inputs = [
    ...passages.map((p) => ({
      id: `passage:${p.passageId}`,
      text: p.text,
      inputHash: inputHashFor(p.text),
    })),
    ...input.probes.map((p) => ({
      id: `probe:${p.id}`,
      text: p.text,
      inputHash: inputHashFor(p.text),
    })),
  ];
  const vectors = new Map(
    (await input.embedder.embed(inputs, input.signal)).map((v) => [v.inputId, v.vector]),
  );
  const vectorOf = (id: string) => {
    const v = vectors.get(id);
    if (!v) throw new ExperimentBoundError(`missing vector for ${id}`);
    return v;
  };

  const rank = (score: (p: Omit<ExperimentMatch, "score">) => number) =>
    passages
      .map((p) => ({ ...p, score: score(p) }))
      .sort((a, b) => b.score - a.score || a.passageId.localeCompare(b.passageId))
      .slice(0, topK);

  const results = input.probes.map((probe) => {
    const pv = vectorOf(`probe:${probe.id}`);
    return {
      probe: { ...probe, synthetic: true as const },
      semantic: rank((p) => cosine(pv, vectorOf(`passage:${p.passageId}`))),
      keyword: rank((p) => keywordOverlap(probe.text, p.text)),
    };
  });
  const probeSimilarity: ExperimentReport["probeSimilarity"] = [];
  for (let i = 0; i < input.probes.length; i++) {
    for (let j = i + 1; j < input.probes.length; j++) {
      const a = input.probes[i]!;
      const b = input.probes[j]!;
      probeSimilarity.push({
        a: a.id,
        b: b.id,
        score: cosine(vectorOf(`probe:${a.id}`), vectorOf(`probe:${b.id}`)),
      });
    }
  }
  return {
    model: { vectorSpace: input.embedder.vectorSpace, dimensions: input.embedder.model.dimensions },
    chunking: chunking!,
    passages: passages.length,
    modelCalls: 1,
    results,
    probeSimilarity,
  };
}

const fmt = (n: number) => n.toFixed(3);

/** Plain-text report; every passage is quoted exactly with its origin and source. */
export function renderExperimentReport(r: ExperimentReport): string {
  const lines = [
    "Semantic match experiment (educational; not retrieval, not verdicts)",
    `Model: ${r.model.vectorSpace} (${r.model.dimensions} dimensions)`,
    `Chunking: splitter v${r.chunking.splitterVersion}, max ${r.chunking.maxChars}, overlap ${r.chunking.overlapChars}`,
    `Sample: ${r.passages} passage(s), ${r.modelCalls} embedding call(s)`,
    "",
    "Similarity is not truth or entailment: a negation or a correction can be as close to a claim as a paraphrase. Ranked passages are candidates to read, not true statements.",
  ];
  for (const res of r.results) {
    lines.push("", `Probe [SYNTHETIC ${res.probe.kind}] ${res.probe.id}: "${res.probe.text}"`);
    for (const [label, matches] of [
      ["semantic", res.semantic],
      ["keyword", res.keyword],
    ] as const) {
      lines.push(`  ${label}:`);
      for (const m of matches) {
        lines.push(
          `    ${fmt(m.score)}  [${m.origin}] ${m.sourceId}${m.url ? ` ${m.url}` : ""} [${m.start},${m.end})`,
          `           "${m.text}"`,
        );
      }
    }
  }
  if (r.probeSimilarity.length) {
    lines.push("", "Probe-to-probe similarity:");
    for (const s of r.probeSimilarity) lines.push(`  ${fmt(s.score)}  ${s.a} ~ ${s.b}`);
  }
  return lines.join("\n");
}
