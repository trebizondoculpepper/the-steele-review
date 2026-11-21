import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact-reference.js";
import { SubstackItemSchema, type SubstackItem } from "./substack-item.js";

/**
 * One searchable full-text document: the retained text of a source post plus
 * the provenance needed to find the exact archived bytes again.
 *
 * Versioning and retry behaviour:
 * - The Elasticsearch document ID is derived from content identity
 *   (`substack:<publicationId>:<postId>`), never generated. Re-indexing the same
 *   version therefore overwrites one document instead of appending a duplicate,
 *   so a retried consumer is idempotent.
 * - {@link sourceVersion} hashes the retained text. A changed source (an edited
 *   post, or a corrected transcript) yields a new version and deliberately
 *   replaces the indexed document; earlier bytes remain addressable through the
 *   immutable `artifact` reference. Keeping every historical version indexable
 *   would need a separate, versioned index and is out of scope here.
 * - `schemaVersion` versions this document contract. It is an index field, not
 *   part of the document ID, so a contract change is a deliberate re-index
 *   rather than a silent one.
 *
 * Dates are ISO 8601 strings with an explicit offset. A date the source does
 * not supply is omitted, never invented.
 */

export const FULLTEXT_SCHEMA_VERSION = 1;

/**
 * Logical index name. The `v1` suffix ties the index to
 * {@link FULLTEXT_SCHEMA_VERSION}: a breaking mapping change needs a new name
 * and a deliberate re-index.
 */
export const FULLTEXT_INDEX_V1 = "steele-source-text-v1";

export const AcquisitionOriginSchema = z
  .enum(["rss-content", "archive-fetch", "transcript"])
  .describe(
    "Where the retained text came from: an RSS feed body, a fetched archive page, or a transcript.",
  );
export type AcquisitionOrigin = z.infer<typeof AcquisitionOriginSchema>;

const SourceVersionSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .describe("Content hash of the retained text, as `sha256:<64 lower-case hex>`.");

const identityFields = SubstackItemSchema.pick({
  publicationId: true,
  postId: true,
  url: true,
  title: true,
  author: true,
  publishedAt: true,
  updatedAt: true,
});

export const FulltextDocumentSchema = identityFields
  .extend({
    schemaVersion: z
      .literal(FULLTEXT_SCHEMA_VERSION)
      .describe("Version of this index-document contract."),
    text: z
      .string()
      .min(1)
      .describe("Retained source text, stored verbatim as archived. Never synthesised here."),
    acquisitionOrigin: AcquisitionOriginSchema,
    sourceVersion: SourceVersionSchema,
    sourceRetrievedAt: z.iso
      .datetime({ offset: true })
      .describe("When the archived bytes behind `artifact` were retrieved from the source."),
    indexedAt: z.iso
      .datetime({ offset: true })
      .describe("When this document was built for indexing."),
    artifact: ArtifactReferenceSchema,
  })
  .strict()
  .meta({
    title: "FulltextDocument",
    description:
      "Searchable source text with content identity, acquisition origin and immutable artifact provenance.",
  });

export type FulltextDocument = z.infer<typeof FulltextDocumentSchema>;

/** Validate an untrusted document, throwing a ZodError when malformed. */
export function parseFulltextDocument(input: unknown): FulltextDocument {
  return FulltextDocumentSchema.parse(input);
}

/** JSON Schema (draft 2020-12) for {@link FulltextDocumentSchema}. */
export function fulltextDocumentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(FulltextDocumentSchema) as Record<string, unknown>;
}

/**
 * Stable Elasticsearch document ID for one source post. Derived from content
 * identity, so a retry addresses the same document.
 */
export function fulltextDocumentId(
  doc: Pick<FulltextDocument, "publicationId" | "postId">,
): string {
  return `substack:${doc.publicationId}:${doc.postId}`;
}

/** Content hash of retained text, used as the source version. */
export function sourceVersionFor(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export interface FulltextDocumentInput {
  /** Normalised post metadata from discovery. */
  item: SubstackItem;
  /** Retained source text, exactly as archived. */
  text: string;
  acquisitionOrigin: AcquisitionOrigin;
  /** Immutable reference to the archived bytes this text was read from. */
  artifact: z.infer<typeof ArtifactReferenceSchema>;
  /** When those archived bytes were retrieved from the source. */
  sourceRetrievedAt: string;
}

/**
 * Build and validate an index document. Inject `now` for deterministic tests.
 * The source version is computed from `text`, never supplied by the caller.
 */
export function createFulltextDocument(
  input: FulltextDocumentInput,
  now: () => Date = () => new Date(),
): FulltextDocument {
  const item = SubstackItemSchema.parse(input.item);
  return FulltextDocumentSchema.parse({
    schemaVersion: FULLTEXT_SCHEMA_VERSION,
    publicationId: item.publicationId,
    postId: item.postId,
    url: item.url,
    title: item.title,
    ...(item.author === undefined ? {} : { author: item.author }),
    ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
    ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
    text: input.text,
    acquisitionOrigin: input.acquisitionOrigin,
    sourceVersion: sourceVersionFor(input.text),
    sourceRetrievedAt: input.sourceRetrievedAt,
    indexedAt: now().toISOString(),
    artifact: ArtifactReferenceSchema.parse(input.artifact),
  });
}

/** Request body for one idempotent index operation. */
export interface FulltextIndexRequest {
  index: { _index: string; _id: string };
  document: FulltextDocument;
}

/**
 * Build the index request for a document. The deterministic `_id` makes the
 * operation safe to retry: the same source version rewrites the same document
 * byte for byte, and a new source version replaces it deliberately.
 */
export function fulltextIndexRequest(
  doc: FulltextDocument,
  index: string = FULLTEXT_INDEX_V1,
): FulltextIndexRequest {
  return {
    index: { _index: index, _id: fulltextDocumentId(doc) },
    document: FulltextDocumentSchema.parse(doc),
  };
}

export interface ElasticsearchFieldMapping {
  type: "keyword" | "text" | "date" | "integer" | "object";
  fields?: Record<string, ElasticsearchFieldMapping>;
  properties?: Record<string, ElasticsearchFieldMapping>;
}

export interface ElasticsearchIndexMapping {
  dynamic: "strict";
  properties: Record<string, ElasticsearchFieldMapping>;
}

/**
 * Explicit mapping for {@link FULLTEXT_INDEX_V1}. It must stay in agreement
 * with {@link FulltextDocumentSchema}: `date` for every optional or required
 * ISO timestamp, `keyword` for identifiers and hashes, `text` for title and
 * body. `dynamic: "strict"` rejects a document field the mapping does not
 * declare, so a schema drift fails at index time instead of silently inventing
 * a field. No vectors or semantic fields are defined here.
 */
export const FULLTEXT_INDEX_MAPPING: ElasticsearchIndexMapping = {
  dynamic: "strict",
  properties: {
    schemaVersion: { type: "integer" },
    publicationId: { type: "keyword" },
    postId: { type: "keyword" },
    url: { type: "keyword" },
    title: {
      type: "text",
      fields: { keyword: { type: "keyword" } },
    },
    publishedAt: { type: "date" },
    updatedAt: { type: "date" },
    author: { type: "keyword" },
    text: { type: "text" },
    acquisitionOrigin: { type: "keyword" },
    sourceVersion: { type: "keyword" },
    sourceRetrievedAt: { type: "date" },
    indexedAt: { type: "date" },
    artifact: {
      type: "object",
      properties: {
        repository: { type: "keyword" },
        commit: { type: "keyword" },
        path: { type: "keyword" },
        hash: { type: "keyword" },
      },
    },
  },
};
