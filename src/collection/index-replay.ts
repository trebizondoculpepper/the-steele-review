import { z } from "zod";
import { CollectionRecordSchema } from "./collection-store.js";
import {
  handleTextReadyEvent,
  type FulltextIndexPort,
  type IndexingOutcome,
} from "./indexing-handler.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { createTextReadyEvent } from "../events/text-ready-event.js";

/**
 * Bounded archive-to-index replay (#26).
 *
 * Rebuilds full-text index documents from committed collection records,
 * through exactly the same projection, mapping and versioned write as the
 * indexing worker (`handleTextReadyEvent`). Nothing is fetched or
 * transcribed, no index is deleted, and no event is published, so replay
 * can never trigger downstream work or publication.
 *
 * Selection is always explicit and bounded: a publication, optionally named
 * posts and a publication-date range, and a required count. Reruns are
 * safe: the index write is externally versioned, so an unchanged record is
 * reported as `unchanged` rather than duplicated.
 */

export const MAX_REPLAY = 1_000;
/** Upper bound on archive paths inspected for one replay. */
export const MAX_REPLAY_SCAN = 20_000;

export const ReplaySelectionSchema = z
  .object({
    publicationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
    postIds: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/))
      .min(1)
      .max(MAX_REPLAY)
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(MAX_REPLAY),
  })
  .strict()
  .refine((s) => !s.from || !s.to || Date.parse(s.from) <= Date.parse(s.to), {
    message: "from must not be after to",
  });
export type ReplaySelection = z.input<typeof ReplaySelectionSchema>;

export interface ReplayReport {
  ok: boolean;
  selected: number;
  indexed: number;
  /** Already indexed at this version; rerun added nothing. */
  unchanged: number;
  incomplete: number;
  /** Outside the date range, or undated when a range was given. */
  skipped: number;
  failed: Array<{ path: string; reason: string }>;
  /** True when the selection limit stopped the replay before the archive was exhausted. */
  truncated: boolean;
  /** True when a shutdown signal stopped the replay before it finished. */
  interrupted: boolean;
}

export async function replayArchiveToIndex(input: {
  selection: ReplaySelection;
  artifacts: Pick<GitArtifactStore, "read" | "lookup" | "list">;
  index: FulltextIndexPort;
  indexName?: string;
  signal?: AbortSignal;
}): Promise<ReplayReport> {
  const sel = ReplaySelectionSchema.parse(input.selection);
  const report: ReplayReport = {
    ok: true,
    selected: 0,
    indexed: 0,
    unchanged: 0,
    incomplete: 0,
    skipped: 0,
    failed: [],
    truncated: false,
    interrupted: false,
  };
  const wanted = sel.postIds ? new Set(sel.postIds) : undefined;
  const listed = await input.artifacts.list(`substack/${sel.publicationId}`, MAX_REPLAY_SCAN);
  // A full listing may have stopped at the scan cap before every record.
  if (listed.length >= MAX_REPLAY_SCAN) report.truncated = true;
  const paths = listed.filter((p) => {
    const parts = p.split("/");
    return (
      parts.length === 4 && parts[3] === "collected.json" && (!wanted || wanted.has(parts[2]!))
    );
  });

  for (const path of paths) {
    if (input.signal?.aborted) {
      // Stopped early: the replay did not finish, so it is not reported as success.
      report.interrupted = true;
      report.ok = false;
      break;
    }
    if (report.selected >= sel.limit) {
      report.truncated = true;
      break;
    }
    const fail = (reason: string) => {
      report.failed.push({ path, reason });
      report.ok = false;
    };
    let record;
    let ref;
    try {
      ref = await input.artifacts.lookup(path);
      if (!ref) continue;
      record = CollectionRecordSchema.parse(JSON.parse(await input.artifacts.read(ref)));
    } catch {
      report.selected++;
      fail("unreadable-record");
      continue;
    }
    // The record must belong to the post its archive path names.
    const [, pathPublication, pathPost] = path.split("/");
    if (record.item.publicationId !== pathPublication || record.item.postId !== pathPost) {
      report.selected++;
      fail("identity-mismatch");
      continue;
    }
    if (sel.from || sel.to) {
      const at = record.item.publishedAt;
      // Compared as instants: offsets differ between sources.
      const t = at ? Date.parse(at) : Number.NaN;
      if (
        Number.isNaN(t) ||
        (sel.from && t < Date.parse(sel.from)) ||
        (sel.to && t > Date.parse(sel.to))
      ) {
        report.skipped++;
        continue;
      }
    }
    report.selected++;
    let outcome: IndexingOutcome;
    try {
      const event = createTextReadyEvent({
        publicationId: record.item.publicationId,
        postId: record.item.postId,
        url: record.item.url,
        // Preserved from the record; replay never becomes a new ingestion.
        ingestionReason: record.ingestionReason,
        artifact: {
          repository: ref.repository,
          commit: ref.commit,
          path: ref.path,
          hash: `sha256:${ref.sha256}`,
        },
        acquisitionMethod: record.provenance.method,
        complete: record.complete,
      });
      outcome = await handleTextReadyEvent({
        event,
        artifacts: input.artifacts,
        index: input.index,
        ...(input.indexName ? { indexName: input.indexName } : {}),
      });
    } catch {
      fail("replay-error");
      continue;
    }
    if (outcome.kind === "indexed") report.indexed++;
    else if (outcome.kind === "stale") report.unchanged++;
    else if (outcome.kind === "incomplete") report.incomplete++;
    else fail(outcome.reason);
  }
  return report;
}
