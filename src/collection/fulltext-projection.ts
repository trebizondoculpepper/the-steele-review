import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import {
  createFulltextDocument,
  fulltextDocumentId,
  type AcquisitionOrigin,
  type FulltextDocument,
} from "../content/fulltext-document.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import { CollectionRecordSchema, type CollectionRecord } from "./collection-store.js";

/**
 * Project an immutable collection artifact into a full-text index document.
 *
 * Reads the exact committed record through the archive controller, checks
 * its integrity and identity, and builds the document with the existing #23
 * factory. Nothing is fetched, generated or written: missing source metadata
 * stays missing, and an acquisition method this projection does not know is
 * reported as invalid rather than guessed.
 *
 * Outcomes are typed so the indexing worker can decide what to do:
 * `projected`, `missing` (no such artifact), `invalid` (integrity, identity
 * or shape problems) and `incomplete` (the record says only part of the
 * content was retained).
 */

export type ProjectionOutcome =
  | { kind: "projected"; id: string; document: FulltextDocument; record: CollectionRecord }
  | { kind: "missing" }
  | {
      kind: "invalid";
      reason:
        | "bad-reference"
        | "hash-mismatch"
        | "malformed-record"
        | "identity-mismatch"
        | "unknown-acquisition-method"
        | "read-failed";
    }
  | { kind: "incomplete"; record: CollectionRecord };

/** Map the collector's acquisition method onto the index's acquisition origin. */
export function acquisitionOriginFor(method: string): AcquisitionOrigin | undefined {
  if (
    method === "supplied-transcript" ||
    method === "supplied-transcript+article-html" ||
    method === "machine-transcript"
  ) {
    return "transcript";
  }
  if (method === "article-html") return "archive-fetch";
  return undefined;
}

/** Convert the index reference shape (`hash: sha256:<hex>`) to the archive's (`sha256: <hex>`). */
export function toArchiveRef(reference: ArtifactReference): ArtifactRef {
  return {
    repository: reference.repository,
    commit: reference.commit,
    path: reference.path,
    sha256: reference.hash.replace(/^sha256:/, ""),
  };
}

export async function projectCollectionArtifact(input: {
  artifacts: Pick<GitArtifactStore, "read">;
  reference: unknown;
  /** Identity the caller expects, e.g. from the text-ready event. */
  expected: { publicationId: string; postId: string };
  now?: () => Date;
}): Promise<ProjectionOutcome> {
  const reference = ArtifactReferenceSchema.safeParse(input.reference);
  if (!reference.success) return { kind: "invalid", reason: "bad-reference" };

  let content: string;
  try {
    content = await input.artifacts.read(toArchiveRef(reference.data));
  } catch (error) {
    if (error instanceof ArtifactStoreError) {
      if (error.code === "not-found") return { kind: "missing" };
      if (error.code === "hash-mismatch") return { kind: "invalid", reason: "hash-mismatch" };
    }
    return { kind: "invalid", reason: "read-failed" };
  }

  let record: CollectionRecord;
  try {
    record = CollectionRecordSchema.parse(JSON.parse(content));
  } catch {
    return { kind: "invalid", reason: "malformed-record" };
  }
  if (
    record.item.publicationId !== input.expected.publicationId ||
    record.item.postId !== input.expected.postId
  ) {
    return { kind: "invalid", reason: "identity-mismatch" };
  }
  if (!record.complete) return { kind: "incomplete", record };

  const origin = acquisitionOriginFor(record.provenance.method);
  if (!origin) return { kind: "invalid", reason: "unknown-acquisition-method" };

  let document: FulltextDocument;
  try {
    document = createFulltextDocument(
      {
        item: record.item,
        text: record.text,
        acquisitionOrigin: origin,
        artifact: reference.data,
        sourceRetrievedAt: record.provenance.acquiredAt,
      },
      input.now,
    );
  } catch {
    return { kind: "invalid", reason: "malformed-record" };
  }
  return { kind: "projected", id: fulltextDocumentId(document), document, record };
}
