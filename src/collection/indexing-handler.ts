import type { CloudEvent } from "cloudevents";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { IndexingError } from "../controllers/elasticsearch.js";
import { FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import type { TextReadyData } from "../events/text-ready-event.js";
import { projectCollectionArtifact } from "./fulltext-projection.js";

/**
 * Handle one validated text-ready event: project the exact committed
 * collection record (#93) and index it under its stable document ID through
 * the existing Elasticsearch controller (#24).
 *
 * - One attempt per call. The request timeout is bounded here; redelivery
 *   and backoff belong to the consumer (#95), which also owns acknowledgment.
 * - Repeated delivery writes the same document ID.
 * - The write carries the record's retrieval time as an external version, so
 *   a delayed event for an older retrieval of the same post is rejected by
 *   Elasticsearch and reported as `stale`, never silently overwriting newer
 *   text. Re-indexing the same retrieval is also reported as `stale` (no-op).
 * - Outcomes say whether the consumer should acknowledge (`indexed`,
 *   `stale`, `incomplete`, `failed`) or redeliver (`retry`).
 */

export type IndexingOutcome =
  | { kind: "indexed"; documentId: string; version: number }
  | { kind: "stale"; documentId: string }
  | { kind: "incomplete" }
  | { kind: "retry"; reason: string }
  | { kind: "failed"; reason: string };

export interface FulltextIndexPort {
  indexDocument(
    index: string,
    id: string,
    document: unknown,
    options?: { version?: number; timeoutMs?: number },
  ): Promise<unknown>;
}

export async function handleTextReadyEvent(input: {
  event: CloudEvent<TextReadyData>;
  artifacts: Pick<GitArtifactStore, "read">;
  index: FulltextIndexPort;
  indexName?: string;
  timeoutMs?: number;
  now?: () => Date;
}): Promise<IndexingOutcome> {
  const data = input.event.data;
  if (!data) return { kind: "failed", reason: "event-without-data" };
  if (input.event.subject !== `substack/${data.publicationId}/${data.postId}`) {
    return { kind: "failed", reason: "subject-mismatch" };
  }

  const projection = await projectCollectionArtifact({
    artifacts: input.artifacts,
    reference: data.artifact,
    expected: { publicationId: data.publicationId, postId: data.postId },
    now: input.now,
  });
  if (projection.kind === "incomplete") return { kind: "incomplete" };
  if (projection.kind === "missing") return { kind: "failed", reason: "artifact-missing" };
  if (projection.kind === "invalid") {
    // A transient archive read failure is worth another delivery; the rest are permanent.
    return projection.reason === "read-failed"
      ? { kind: "retry", reason: "archive-read-failed" }
      : { kind: "failed", reason: projection.reason };
  }
  if (projection.document.url !== data.url) return { kind: "failed", reason: "source-mismatch" };

  const version = Date.parse(projection.document.sourceRetrievedAt);
  try {
    await input.index.indexDocument(
      input.indexName ?? FULLTEXT_INDEX_V1,
      projection.id,
      projection.document,
      {
        version,
        timeoutMs: Math.min(60_000, Math.max(1_000, input.timeoutMs ?? 10_000)),
      },
    );
  } catch (error) {
    const category =
      error instanceof IndexingError ? error.category : (error as { category?: string }).category;
    const retryable =
      error instanceof IndexingError
        ? error.retryable
        : (error as { retryable?: boolean }).retryable;
    if (category === "stale-version") return { kind: "stale", documentId: projection.id };
    if (retryable === true) return { kind: "retry", reason: category ?? "index-failed" };
    return { kind: "failed", reason: category ?? "index-failed" };
  }
  return { kind: "indexed", documentId: projection.id, version };
}
