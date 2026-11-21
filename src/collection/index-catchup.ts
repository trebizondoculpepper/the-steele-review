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
 * marker keeps `pending`, and the next pass reconciles every current record
 * (a full pass) rather than trusting a diff from a checkpoint the index may
 * have moved past.
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
  const from = marker.pending ? undefined : marker.commit;
  const { head, full, changes } = await input.artifacts.changesSince(from);
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
      if (!found) continue;
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
      commit: head,
      completedAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    report.checkpointAdvanced = true;
  }
  return report;
}
