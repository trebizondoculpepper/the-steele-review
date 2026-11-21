import { createTextReadyEvent } from "../events/text-ready-event.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { fulltextDocumentId } from "../content/fulltext-document.js";
import { CollectionRecordSchema } from "./collection-store.js";
import { handleTextReadyEvent, type FulltextIndexPort } from "./indexing-handler.js";

/**
 * Incremental captured-post indexing from Git (#250).
 *
 * Applies every archive change since the last successful checkpoint to the
 * full-text index: added and revised capture records are indexed (the
 * existing handler skips versions already indexed), and removed records are
 * deleted from the index. It reuses the research reconciliation pattern
 * (#225): changes come from `changesSince`, each record is read at exactly
 * the head this pass applies, and the checkpoint only advances after every
 * change succeeded.
 *
 * The checkpoint is the same JSON marker the bulk load writes (#249): its
 * `commit` is the archive revision the index reflects. A pass marks itself
 * `pending` before writing; if it is interrupted or a change fails, the
 * marker keeps its last good `commit`, and the next pass reapplies every
 * change since then (including deletions it had not reached). The writes are
 * idempotent: indexing is externally versioned and deletes are repeatable.
 * The checkpoint records its publication scope; a pass for another scope is
 * refused rather than trusting a commit that never covered it.
 *
 * A full pass indexes every current record but cannot detect records removed
 * before it started, because the strict index mapping has no generation
 * field. The archive is append-and-revise, so removals are rare; a removal
 * made after a successful checkpoint is always applied by the next
 * incremental pass.
 */

export interface CatchUpCheckpointState {
  /** Archive revision the index fully reflects. */
  commit?: string;
  /** Head a pass began applying and has not finished. */
  pending?: string;
  /** Bulk-load fields (#249) are kept as they are. */
  [key: string]: unknown;
}

export interface CatchUpCheckpointStore {
  load(): Promise<CatchUpCheckpointState | undefined>;
  save(state: CatchUpCheckpointState): Promise<void>;
}

export interface CatchUpReport {
  ok: boolean;
  head?: string;
  /** True when every current record was reconciled (no usable checkpoint). */
  full: boolean;
  /** Nothing changed since the checkpoint. */
  unchanged: boolean;
  indexed: number;
  /** Already indexed at this version. */
  stale: number;
  incomplete: number;
  removed: number;
  failed: Array<{ path: string; reason: string }>;
  interrupted: boolean;
  checkpointAdvanced: boolean;
}

const CAPTURE = /^substack\/([a-z0-9][a-z0-9-]*)\/([^/]+)\/collected\.json$/;

export async function catchUpIndex(input: {
  artifacts: Pick<GitArtifactStore, "changesSince" | "lookupAt" | "read">;
  index: FulltextIndexPort & {
    deleteDocument(index: string, id: string): Promise<unknown>;
  };
  indexName?: string;
  checkpoint: CatchUpCheckpointStore;
  /** Restrict the pass to one publication; others are left for their own passes. */
  publicationId?: string;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<CatchUpReport> {
  const indexName = input.indexName ?? "steele-source-text-v1";
  const marker = (await input.checkpoint.load()) ?? {};
  // A checkpoint is only valid for the publication scope it was made for.
  const scope = typeof marker.publicationId === "string" ? marker.publicationId : undefined;
  // A filtered bulk load (#249: --post, --from, --to) never covered the whole publication.
  const partial = marker.wholePublication === false;
  if (partial || (scope !== undefined && scope !== input.publicationId)) {
    return {
      ok: false,
      full: false,
      unchanged: false,
      indexed: 0,
      stale: 0,
      incomplete: 0,
      removed: 0,
      failed: [
        { path: "", reason: partial ? "checkpoint-incomplete" : "checkpoint-scope-mismatch" },
      ],
      interrupted: false,
      checkpointAdvanced: false,
    };
  }
  // An unfinished pass is retried from the last good commit, so every change
  // it had not applied (including deletions) is applied again.
  const from = marker.commit;
  const since = await input.artifacts.changesSince(from);
  const { head, full } = since;
  const changes = [...since.changes];
  // Recovering a pass that stopped part-way: it may have written documents at
  // its own head that later commits removed or reverted. Reconcile every path
  // it could have touched against the current head as well.
  if (marker.pending && head && marker.pending !== head) {
    const seen = new Set(changes.map((c) => c.path));
    for (const c of (await input.artifacts.changesSince(marker.pending)).changes) {
      if (!seen.has(c.path)) changes.push({ path: c.path, change: "upsert" });
    }
  }
  const report: CatchUpReport = {
    ok: true,
    ...(head ? { head } : {}),
    full,
    unchanged: false,
    indexed: 0,
    stale: 0,
    incomplete: 0,
    removed: 0,
    failed: [],
    interrupted: false,
    checkpointAdvanced: false,
  };
  if (!head || (!full && head === from)) {
    report.unchanged = true;
    return report;
  }
  // Recorded before any write, so an interrupted pass is never trusted.
  await input.checkpoint.save({ ...marker, pending: head });

  const fail = (path: string, reason: string) => {
    report.failed.push({ path, reason });
    report.ok = false;
  };
  for (const { path, change } of changes) {
    const match = CAPTURE.exec(path);
    if (!match) continue;
    const [, publicationId, postId] = match as unknown as [string, string, string];
    if (input.publicationId && publicationId !== input.publicationId) continue;
    if (input.signal?.aborted) {
      report.interrupted = true;
      report.ok = false;
      break;
    }
    const id = fulltextDocumentId({ publicationId, postId });
    if (change === "delete") {
      try {
        await input.index.deleteDocument(indexName, id);
        report.removed++;
      } catch {
        fail(path, "delete-failed");
      }
      continue;
    }
    let found;
    let record;
    try {
      found = await input.artifacts.lookupAt(head, path);
      if (!found) {
        // Absent at this head: no document may remain for it.
        await input.index.deleteDocument(indexName, id);
        report.removed++;
        continue;
      }
      record = CollectionRecordSchema.parse(JSON.parse(found.content));
    } catch {
      fail(path, "unreadable-record");
      continue;
    }
    if (record.item.publicationId !== publicationId || record.item.postId !== postId) {
      fail(path, "identity-mismatch");
      continue;
    }
    try {
      const outcome = await handleTextReadyEvent({
        event: createTextReadyEvent({
          publicationId,
          postId,
          url: record.item.url,
          ingestionReason: record.ingestionReason,
          artifact: {
            repository: found.ref.repository,
            // The bytes this pass read are the ones at its head; a revised
            // record's introducing commit would point at older content.
            commit: head,
            path: found.ref.path,
            hash: `sha256:${found.ref.sha256}`,
          },
          acquisitionMethod: record.provenance.method,
          complete: record.complete,
        }),
        artifacts: input.artifacts,
        index: input.index,
        indexName,
      });
      if (outcome.kind === "indexed") report.indexed++;
      else if (outcome.kind === "stale") report.stale++;
      else if (outcome.kind === "incomplete") report.incomplete++;
      else fail(path, outcome.reason);
    } catch {
      fail(path, "index-error");
    }
  }
  if (report.ok) {
    const { pending: _pending, ...rest } = marker;
    await input.checkpoint.save({
      ...rest,
      ...(input.publicationId ? { publicationId: input.publicationId } : {}),
      commit: head,
      completedAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    report.checkpointAdvanced = true;
  }
  return report;
}
