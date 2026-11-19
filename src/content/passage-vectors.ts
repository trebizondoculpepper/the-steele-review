import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EmbeddingModelSchema,
  vectorSpaceId,
  type EmbeddingModel,
  type EmbeddingVector,
} from "../controllers/embedding.js";
import type { SearchHit } from "../controllers/elasticsearch.js";
import { ArtifactReferenceSchema, type ArtifactReference } from "./artifact-reference.js";
import type { Passage } from "./passages.js";

/**
 * Versioned passage-vector storage in Elasticsearch (Basic tier dense
 * vectors with approximate kNN; see doc/findings/elasticsearch-vector-capability.md).
 *
 * One vector space (embedding provider, model, version and dimensions) maps
 * to one logical index, so vectors from different models can never be
 * compared or stored together. Changing model or dimensions means
 * provisioning and filling a new index deliberately; nothing is rewritten in
 * place. Each document keeps passage identity, exact text, source provenance,
 * splitter version and the model that produced its vector.
 */

export const PASSAGE_VECTOR_SCHEMA_VERSION = 1;
export const PASSAGE_VECTOR_FIELD = "embedding";

/** Logical index (alias) for one vector space. */
export function passageVectorIndexName(model: EmbeddingModel): string {
  const space = createHash("sha256").update(vectorSpaceId(model)).digest("hex").slice(0, 16);
  return `steele-passage-vectors-v${PASSAGE_VECTOR_SCHEMA_VERSION}-${space}`;
}

/** Explicit strict mapping for a vector space's index. */
export function passageVectorMapping(model: EmbeddingModel) {
  const valid = EmbeddingModelSchema.parse(model);
  return {
    dynamic: "strict",
    properties: {
      schemaVersion: { type: "integer" },
      passageId: { type: "keyword" },
      sourceId: { type: "keyword" },
      sourceVersion: { type: "keyword" },
      splitterVersion: { type: "integer" },
      start: { type: "integer" },
      end: { type: "integer" },
      text: { type: "text" },
      publishedAt: { type: "date" },
      transcriptTimings: {
        type: "object",
        properties: { startSeconds: { type: "float" }, endSeconds: { type: "float" } },
      },
      artifact: {
        type: "object",
        properties: {
          repository: { type: "keyword" },
          commit: { type: "keyword" },
          path: { type: "keyword" },
          hash: { type: "keyword" },
        },
      },
      inputHash: { type: "keyword" },
      vectorSpace: { type: "keyword" },
      model: {
        type: "object",
        properties: {
          provider: { type: "keyword" },
          model: { type: "keyword" },
          version: { type: "keyword" },
          dimensions: { type: "integer" },
        },
      },
      [PASSAGE_VECTOR_FIELD]: {
        type: "dense_vector",
        dims: valid.dimensions,
        index: true,
        similarity: "cosine",
      },
    },
  } as const;
}

export const PassageVectorDocumentSchema = z
  .object({
    schemaVersion: z.literal(PASSAGE_VECTOR_SCHEMA_VERSION),
    passageId: z.string().min(1),
    sourceId: z.string().min(1),
    sourceVersion: z.string().min(1),
    splitterVersion: z.number().int().positive(),
    start: z.number().int().min(0),
    end: z.number().int().min(1),
    text: z.string().min(1),
    publishedAt: z.iso.datetime({ offset: true }).optional(),
    /** Supplied media timings overlapping the passage; absent when none were supplied. */
    transcriptTimings: z
      .array(
        z
          .object({ startSeconds: z.number().nonnegative(), endSeconds: z.number().nonnegative() })
          .strict(),
      )
      .max(500)
      .optional(),
    artifact: ArtifactReferenceSchema,
    inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    vectorSpace: z.string().min(1),
    model: EmbeddingModelSchema,
    [PASSAGE_VECTOR_FIELD]: z.array(z.number().finite()).min(1),
  })
  .strict();
export type PassageVectorDocument = z.infer<typeof PassageVectorDocumentSchema>;

export class VectorSpaceError extends Error {
  constructor(reason: string) {
    super(`passage vector rejected: ${reason}`);
    this.name = "VectorSpaceError";
  }
}

/** Narrow Elasticsearch surface used here, injectable for tests. */
export interface PassageVectorIndex {
  provisionIndex(alias: string, mappings: unknown): Promise<"created" | "unchanged">;
  indexDocument(index: string, id: string, document: unknown): Promise<unknown>;
  knnSearch(
    index: string,
    request: {
      field: string;
      queryVector: number[];
      k: number;
      numCandidates?: number;
      filter?: unknown;
      excludeFields?: string[];
    },
  ): Promise<SearchHit[]>;
}

export interface PassageMatch {
  score: number;
  passageId: string;
  sourceId: string;
  text: string;
  start: number;
  end: number;
  artifact: ArtifactReference;
  publishedAt?: string;
  transcriptTimings?: Array<{ startSeconds: number; endSeconds: number }>;
}

export class PassageVectorStore {
  readonly indexName: string;
  readonly vectorSpace: string;

  constructor(
    private readonly es: PassageVectorIndex,
    readonly model: EmbeddingModel,
  ) {
    this.vectorSpace = vectorSpaceId(EmbeddingModelSchema.parse(model));
    this.indexName = passageVectorIndexName(model);
  }

  /** Explicitly create this vector space's index; an existing one is left unchanged. */
  provision(): Promise<"created" | "unchanged"> {
    return this.es.provisionIndex(this.indexName, passageVectorMapping(this.model));
  }

  /** Build a validated document, refusing vectors from another space or passage. */
  document(
    passage: Passage,
    vector: EmbeddingVector,
    artifact: ArtifactReference,
  ): PassageVectorDocument {
    if (vector.vectorSpace !== this.vectorSpace) {
      throw new VectorSpaceError("vector belongs to a different model or dimension");
    }
    if (vector.vector.length !== this.model.dimensions) {
      throw new VectorSpaceError("vector length does not match model dimensions");
    }
    if (vector.inputId !== passage.id) throw new VectorSpaceError("vector is for another passage");
    return PassageVectorDocumentSchema.parse({
      schemaVersion: PASSAGE_VECTOR_SCHEMA_VERSION,
      passageId: passage.id,
      sourceId: passage.sourceId,
      sourceVersion: passage.sourceVersion,
      splitterVersion: passage.splitterVersion,
      start: passage.start,
      end: passage.end,
      text: passage.text,
      ...(passage.publishedAt ? { publishedAt: passage.publishedAt } : {}),
      ...(passage.transcriptTimings?.length
        ? { transcriptTimings: passage.transcriptTimings }
        : {}),
      artifact,
      inputHash: vector.inputHash,
      vectorSpace: vector.vectorSpace,
      model: vector.model,
      [PASSAGE_VECTOR_FIELD]: vector.vector,
    });
  }

  /** Index one passage vector under a stable ID; a repeat write replaces the same document. */
  async write(
    passage: Passage,
    vector: EmbeddingVector,
    artifact: ArtifactReference,
  ): Promise<void> {
    const doc = this.document(passage, vector, artifact);
    await this.es.indexDocument(this.indexName, doc.passageId, doc);
  }

  /** Nearest passages to a query vector from the same vector space. */
  async nearest(
    queryVector: number[],
    k = 10,
    filter?: { sourceId?: string },
  ): Promise<PassageMatch[]> {
    if (queryVector.length !== this.model.dimensions || !queryVector.every(Number.isFinite)) {
      throw new VectorSpaceError("query vector does not match model dimensions");
    }
    const hits = await this.es.knnSearch(this.indexName, {
      field: PASSAGE_VECTOR_FIELD,
      queryVector,
      k,
      ...(filter?.sourceId ? { filter: { term: { sourceId: filter.sourceId } } } : {}),
      excludeFields: [PASSAGE_VECTOR_FIELD],
    });
    const matches: PassageMatch[] = [];
    for (const hit of hits) {
      const doc = PassageVectorDocumentSchema.omit({ [PASSAGE_VECTOR_FIELD]: true }).safeParse(
        hit.source,
      );
      if (!doc.success || doc.data.vectorSpace !== this.vectorSpace) continue;
      matches.push({
        score: hit.score,
        passageId: doc.data.passageId,
        sourceId: doc.data.sourceId,
        text: doc.data.text,
        start: doc.data.start,
        end: doc.data.end,
        artifact: doc.data.artifact,
        ...(doc.data.publishedAt ? { publishedAt: doc.data.publishedAt } : {}),
        ...(doc.data.transcriptTimings ? { transcriptTimings: doc.data.transcriptTimings } : {}),
      });
    }
    return matches;
  }
}
