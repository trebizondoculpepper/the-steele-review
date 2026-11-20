import { createHash } from "node:crypto";
import { z } from "zod";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { ElasticsearchIndexMapping } from "../content/fulltext-document.js";
import type { ElasticsearchController } from "../controllers/elasticsearch.js";

/**
 * Full-text indexing of the private research collection (#225).
 *
 * Only explicitly identified document kinds are indexed: dossiers, research
 * reports (manual imports and job reports), job covering notes and readable
 * source snapshots. Control records (requests, results, manifests,
 * catalogue, claims, extraction results) and anything unrecognised stay out.
 *
 * Each document's ID is derived from its artifact path, so replaying the same
 * revision rewrites the same document and a revision replaces it in place.
 * Every write records the exact commit and content hash it came from.
 *
 * The durable checkpoint is a marker document in the same index holding the
 * last fully indexed commit. Reconciliation diffs from it; if it is missing
 * or no longer an ancestor (for example the index was rebuilt), every
 * indexable artifact is rewritten and documents not seen in that pass are
 * removed. The checkpoint only advances after every change is applied.
 */

/** Distinct from the research-entry store's `steele-research-v1`, whose mapping differs. */
export const RESEARCH_COLLECTION_INDEX_V1 = "steele-research-collection-v1";
export const RESEARCH_INDEX_SCHEMA_VERSION = 1;
const CHECKPOINT_ID = "checkpoint";
const MAX_TEXT_CHARS = 1_000_000;

export type ResearchDocumentKind =
  | "dossier"
  | "research-report"
  | "covering-note"
  | "source-snapshot";

export const RESEARCH_COLLECTION_INDEX_MAPPING: ElasticsearchIndexMapping = {
  dynamic: "strict",
  properties: {
    schemaVersion: { type: "integer" },
    kind: { type: "keyword" },
    path: { type: "keyword" },
    title: { type: "text" },
    text: { type: "text" },
    url: { type: "keyword" },
    jobId: { type: "keyword" },
    artifactRepository: { type: "keyword" },
    artifactCommit: { type: "keyword" },
    artifactHash: { type: "keyword" },
    /** Commit of the reconciliation pass that last wrote the document. */
    generation: { type: "keyword" },
    checkpoint: { type: "keyword" },
    /** Head of a pass that started but has not yet completed. */
    pending: { type: "keyword" },
  },
};

const JOB = /^research-jobs\/(research-[0-9a-f]{32})\//;

/** The kind of an indexable artifact path, or undefined for anything that must stay out of search. */
export function researchDocumentKind(path: string): ResearchDocumentKind | undefined {
  if (/^dossier\/[^/]+\.md$/.test(path)) return "dossier";
  if (/^research-reports\/.+\.md$/.test(path)) return "research-report";
  if (/^research-jobs\/research-[0-9a-f]{32}\/report\.md$/.test(path)) return "research-report";
  if (/^research-jobs\/research-[0-9a-f]{32}\/(covering-note|coverage)\.md$/.test(path))
    return "covering-note";
  if (/^research-jobs\/research-[0-9a-f]{32}\/sources\/[^/]+\.json$/.test(path))
    return "source-snapshot";
  return undefined;
}

export const researchDocumentId = (path: string) =>
  `doc-${createHash("sha256").update(path).digest("hex").slice(0, 40)}`;

const Snapshot = z.looseObject({
  url: z.string().optional(),
  title: z.string().optional(),
  text: z.string(),
});

/** Searchable fields for one artifact; undefined when its content is unreadable for search. */
export function researchDocument(
  path: string,
  content: string,
):
  | { kind: ResearchDocumentKind; title: string; text: string; url?: string; jobId?: string }
  | undefined {
  const kind = researchDocumentKind(path);
  if (!kind) return undefined;
  const jobId = JOB.exec(path)?.[1];
  if (kind === "source-snapshot") {
    let snap;
    try {
      snap = Snapshot.parse(JSON.parse(content));
    } catch {
      return undefined;
    }
    return {
      kind,
      title: snap.title ?? snap.url ?? path,
      text: snap.text.slice(0, MAX_TEXT_CHARS),
      ...(snap.url ? { url: snap.url } : {}),
      ...(jobId ? { jobId } : {}),
    };
  }
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  return {
    kind,
    title: heading ?? path.split("/").pop()!.replace(/\.md$/, ""),
    text: content.slice(0, MAX_TEXT_CHARS),
    ...(jobId ? { jobId } : {}),
  };
}

export interface ReconcileReport {
  head?: string;
  full: boolean;
  indexed: number;
  removed: number;
  skipped: number;
  unchanged: boolean;
}

export async function readResearchCheckpoint(
  es: Pick<ElasticsearchController, "search">,
  index: string,
): Promise<{ checkpoint?: string; pending?: string }> {
  const hits = await es.search(index, { ids: { values: [CHECKPOINT_ID] } }, { size: 1 });
  const source = hits[0]?.source as { checkpoint?: unknown; pending?: unknown } | undefined;
  return {
    ...(typeof source?.checkpoint === "string" ? { checkpoint: source.checkpoint } : {}),
    ...(typeof source?.pending === "string" ? { pending: source.pending } : {}),
  };
}

/**
 * One reconciliation pass: apply every committed change since the
 * checkpoint, then advance it. Safe to repeat; a failure leaves the
 * checkpoint where it was so the next pass retries the same changes.
 */
export async function reconcileResearchIndex(input: {
  artifacts: GitArtifactStore;
  es: Pick<
    ElasticsearchController,
    "search" | "indexDocument" | "deleteDocument" | "deleteMatching"
  >;
  index?: string;
  refresh?: boolean;
}): Promise<ReconcileReport> {
  const index = input.index ?? RESEARCH_COLLECTION_INDEX_V1;
  const options = input.refresh ? { refresh: "wait_for" as const } : {};
  const marker = await readResearchCheckpoint(input.es, index);
  // A pass that started but never completed may have written documents from a
  // newer head than the checkpoint; diffing from the checkpoint could then miss
  // a later revert. Reconcile everything in that case.
  const checkpoint = marker.pending ? undefined : marker.checkpoint;
  const { head, full, changes } = await input.artifacts.changesSince(checkpoint);
  if (!head) return { full, indexed: 0, removed: 0, skipped: 0, unchanged: true };
  if (!full && head === checkpoint)
    return { head, full, indexed: 0, removed: 0, skipped: 0, unchanged: true };

  // Record that a pass is in progress before writing anything.
  await input.es.indexDocument(
    index,
    CHECKPOINT_ID,
    {
      schemaVersion: RESEARCH_INDEX_SCHEMA_VERSION,
      kind: "checkpoint",
      ...(marker.checkpoint ? { checkpoint: marker.checkpoint } : {}),
      pending: head,
    },
    options,
  );
  let indexed = 0;
  let removed = 0;
  let skipped = 0;
  for (const { path, change } of changes) {
    if (!researchDocumentKind(path)) continue;
    const id = researchDocumentId(path);
    if (change === "delete") {
      await input.es.deleteDocument(index, id, options);
      removed++;
      continue;
    }
    const ref = await input.artifacts.lookup(path);
    const fields = ref ? researchDocument(path, await input.artifacts.read(ref)) : undefined;
    if (!ref || !fields) {
      // Unreadable for search: make sure no stale copy lingers.
      await input.es.deleteDocument(index, id, options);
      skipped++;
      continue;
    }
    await input.es.indexDocument(
      index,
      id,
      {
        schemaVersion: RESEARCH_INDEX_SCHEMA_VERSION,
        ...fields,
        path,
        artifactRepository: ref.repository,
        artifactCommit: ref.commit,
        artifactHash: `sha256:${ref.sha256}`,
        generation: head,
      },
      options,
    );
    indexed++;
  }
  if (full) {
    // Anything not rewritten in a full pass is no longer in the collection.
    removed += await input.es.deleteMatching(
      index,
      {
        bool: { must_not: [{ term: { generation: head } }, { ids: { values: [CHECKPOINT_ID] } }] },
      },
      input.refresh ? { refresh: true } : {},
    );
  }
  await input.es.indexDocument(
    index,
    CHECKPOINT_ID,
    { schemaVersion: RESEARCH_INDEX_SCHEMA_VERSION, kind: "checkpoint", checkpoint: head },
    options,
  );
  return { head, full, indexed, removed, skipped, unchanged: false };
}
