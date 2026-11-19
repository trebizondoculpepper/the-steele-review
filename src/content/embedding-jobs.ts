import { createHash } from "node:crypto";
import {
  EmbeddingModelSchema,
  inputHashFor,
  vectorSpaceId,
  type EmbeddingModel,
} from "../controllers/embedding.js";
import type { ArtifactReference } from "./artifact-reference.js";
import {
  DEFAULT_CHUNKING,
  chunkingKey,
  passageVectorIndexName,
  type ChunkingConfig,
} from "./passage-vectors.js";
import {
  PASSAGE_SPLITTER_VERSION,
  splitPassages,
  type Passage,
  type TranscriptTiming,
} from "./passages.js";

/**
 * Pure planning of passage embedding jobs (#30, first slice).
 *
 * A plan splits one versioned source with a fixed chunking configuration and
 * lists one job per passage, in source order, for one embedding model.
 * Nothing is called here: no provider, index, state or broker.
 *
 * Keys:
 * - `jobKey` identifies the work: source version, passage, vector space
 *   (provider, model, version, dimensions) and chunking configuration. A
 *   repeated plan for the same input yields the same job keys.
 * - `reuseKey` identifies a reusable result: the passage text's hash, vector
 *   space and splitter version. A stored vector with the same reuse key can be
 *   reused without a provider call, even for another source with identical
 *   passage text. Any change of model, dimensions or splitter changes the
 *   key, so new jobs are created deliberately and vectors are never mixed.
 */

export const DEFAULT_MAX_JOBS = 2_000;

export interface EmbeddingJob {
  jobKey: string;
  reuseKey: string;
  /** Position in source order. */
  position: number;
  passage: Passage;
  /** sha256 of the passage text, as the embedding controller expects. */
  inputHash: string;
}

export interface EmbeddingPlan {
  sourceId: string;
  sourceVersion: string;
  artifact: ArtifactReference;
  model: EmbeddingModel;
  vectorSpace: string;
  chunking: ChunkingConfig;
  chunkingKey: string;
  /** Logical index the vectors belong in (one per vector space and chunking). */
  indexName: string;
  jobs: EmbeddingJob[];
}

export class EmbeddingPlanError extends Error {
  constructor(
    readonly reason: "too-many-passages" | "invalid-model" | "unsupported-splitter-version",
  ) {
    super(`embedding plan refused: ${reason}`);
    this.name = "EmbeddingPlanError";
  }
}

const sha = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;

export function reuseKeyFor(
  inputHash: string,
  model: EmbeddingModel,
  splitterVersion: number,
): string {
  return sha([inputHash, vectorSpaceId(model), splitterVersion]);
}

export function planEmbeddingJobs(input: {
  sourceId: string;
  text: string;
  sourceVersion: string;
  artifact: ArtifactReference;
  model: EmbeddingModel;
  chunking?: ChunkingConfig;
  publishedAt?: string;
  transcriptTimings?: TranscriptTiming[];
  maxJobs?: number;
}): EmbeddingPlan {
  const parsedModel = EmbeddingModelSchema.safeParse(input.model);
  if (!parsedModel.success) throw new EmbeddingPlanError("invalid-model");
  const model = parsedModel.data;
  const chunking = input.chunking ?? DEFAULT_CHUNKING;
  // Only the splitter this code runs can produce the passages a plan names;
  // labelling them with another version would mix chunking generations.
  if (chunking.splitterVersion !== PASSAGE_SPLITTER_VERSION) {
    throw new EmbeddingPlanError("unsupported-splitter-version");
  }
  const vectorSpace = vectorSpaceId(model);
  const key = chunkingKey(chunking);
  const base = {
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    artifact: input.artifact,
    model,
    vectorSpace,
    chunking,
    chunkingKey: key,
    indexName: passageVectorIndexName(model, chunking),
  };
  if (input.text.trim().length === 0) return { ...base, jobs: [] };

  const passages = splitPassages(
    {
      sourceId: input.sourceId,
      text: input.text,
      sourceVersion: input.sourceVersion,
      ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
      ...(input.transcriptTimings ? { transcriptTimings: input.transcriptTimings } : {}),
    },
    {
      maxChars: chunking.maxChars,
      overlapChars: chunking.overlapChars,
      minChars: chunking.minChars,
    },
  ).passages;
  if (passages.length > (input.maxJobs ?? DEFAULT_MAX_JOBS)) {
    throw new EmbeddingPlanError("too-many-passages");
  }
  const jobs = passages.map((passage, position) => {
    const inputHash = inputHashFor(passage.text);
    return {
      jobKey: sha([input.sourceVersion, passage.id, vectorSpace, key]),
      reuseKey: reuseKeyFor(inputHash, model, chunking.splitterVersion),
      position,
      passage,
      inputHash,
    };
  });
  return { ...base, jobs };
}

/**
 * Split a plan's jobs into those whose results already exist (by reuse key)
 * and those that need a provider call. Pure: the caller supplies the known
 * reuse keys from storage.
 */
export function partitionReusable(
  plan: EmbeddingPlan,
  knownReuseKeys: ReadonlySet<string>,
): { reusable: EmbeddingJob[]; toEmbed: EmbeddingJob[] } {
  const reusable: EmbeddingJob[] = [];
  const toEmbed: EmbeddingJob[] = [];
  for (const job of plan.jobs) (knownReuseKeys.has(job.reuseKey) ? reusable : toEmbed).push(job);
  return { reusable, toEmbed };
}

/** Ordered batches of at most `size` jobs. */
export function batchJobs(jobs: EmbeddingJob[], size: number): EmbeddingJob[][] {
  const n = Math.max(1, Math.floor(size));
  const batches: EmbeddingJob[][] = [];
  for (let i = 0; i < jobs.length; i += n) batches.push(jobs.slice(i, i + n));
  return batches;
}
