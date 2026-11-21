import { createHash } from "node:crypto";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { PackageDraftMetadataSchema } from "../drafting/package-draft.js";
import { PackageVerificationReportSchema } from "../drafting/package-verify.js";
import type { ReceiptView, ReceiptsPort } from "./articles.js";

/**
 * Inventory of every saved package draft (#440), manual or from a workflow.
 *
 * Read through the artifact controller only, in bounded pages. A draft's
 * status comes from exact bindings, never from a filename, the newest report
 * or a successful run:
 * - approved: a saved verification report whose `draft` names this draft's
 *   repository and full content hash, with outcome `approved`;
 * - redraft: such a report with outcome `redraft` (rejected or unresolved);
 * - unverified: no report binds this exact draft;
 * - unreadable: the metadata or draft could not be read; shown with a stated
 *   limitation rather than a guessed status.
 * Delivery receipts are bound to the full draft hash by the receipt scan;
 * simulated receipts stay labelled, and only a confirmed real delivery has a
 * link.
 */

export const DRAFT_PAGE = 25;
const METADATA_PATH = /^articles\/([^/]+)\/([^/]+)\/([0-9a-f]{32})\.json$/;
export const REPORT_SCAN = 200;
/** Bound on report pages per post (REPORT_SCAN each). */
export const REPORT_MAX_PAGES = 10;

export type DraftStatus = "approved" | "redraft" | "unverified" | "incomplete" | "unreadable";

export interface DraftEntry {
  /** Metadata artifact path: the stable identity used for links. */
  path: string;
  publicationId: string;
  postId: string;
  status: DraftStatus;
  /** Why the status is limited, when it is. */
  limitation?: string;
  hash?: string;
  title?: string;
  subtitle?: string;
  excerpt?: string;
  draftedAt?: string;
  promptVersion?: string;
  modelVersion?: string;
  receipts: ReceiptView[];
  receiptsTruncated?: boolean;
}

export interface DraftPage {
  entries: DraftEntry[];
  /** Pass back to read the next page; absent when the listing was exhausted. */
  next?: string;
}

export interface DraftInventoryPort {
  page(options: { after?: string; publicationId?: string; postId?: string }): Promise<DraftPage>;
  /** The escaped-on-render draft text for one metadata path. */
  text(path: string): Promise<{ entry: DraftEntry; markdown?: string } | undefined>;
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read" | "lookupAt">;
const ID = /^[a-z0-9][a-z0-9-]{0,299}$/;

export function draftInventory(content: Store, receipts?: ReceiptsPort): DraftInventoryPort {
  /**
   * Verification reports for one post, keyed by the exact draft they bind.
   * `incomplete` is set when the scan bound was reached or a listing or report
   * read failed: absence of a verdict then proves nothing.
   */
  const reportsFor = async (publicationId: string, postId: string) => {
    const bound = new Map<string, "approved" | "redraft">();
    let incomplete = false;
    let after: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= REPORT_MAX_PAGES) {
        incomplete = true;
        break;
      }
      let paths: string[];
      try {
        paths = await content.list(`verifications/${publicationId}/${postId}`, REPORT_SCAN, after);
      } catch {
        incomplete = true;
        break;
      }
      for (const path of paths) {
        try {
          const ref = await content.lookup(path);
          if (!ref) continue;
          const parsed = PackageVerificationReportSchema.safeParse(
            JSON.parse(await content.read(ref)),
          );
          if (!parsed.success) continue; // legacy or wrapper formats bind nothing here
          const key = `${parsed.data.draft.repository}|${parsed.data.draft.hash}`;
          // Approval for one exact draft is never overridden by another report.
          if (bound.get(key) !== "approved") bound.set(key, parsed.data.outcome);
        } catch {
          incomplete = true; // an unreadable report may have been this draft's verdict
        }
      }
      if (paths.length < REPORT_SCAN) break;
      after = paths.at(-1);
    }
    return { bound, incomplete };
  };

  const entryFor = async (
    path: string,
    reports: { bound: Map<string, "approved" | "redraft">; incomplete: boolean },
  ): Promise<{ entry: DraftEntry; markdown?: string }> => {
    const m = METADATA_PATH.exec(path)!;
    const base = { path, publicationId: m[1]!, postId: m[2]!, receipts: [] as ReceiptView[] };
    let meta;
    try {
      const ref = await content.lookup(path);
      if (!ref) throw new Error("missing");
      meta = PackageDraftMetadataSchema.parse(JSON.parse(await content.read(ref)));
    } catch {
      return {
        entry: {
          ...base,
          status: "unreadable",
          limitation: "draft metadata is unreadable or a legacy format",
        },
      };
    }
    const info = {
      ...(meta.fields
        ? {
            title: meta.fields.title,
            subtitle: meta.fields.subtitle,
            excerpt: meta.fields.excerpt,
          }
        : {}),
      draftedAt: meta.draftedAt,
      promptVersion: meta.promptVersion,
      modelVersion: meta.modelVersion,
    };
    const at = meta.draft.indexOf(":");
    let draft;
    try {
      draft = await content.lookupAt(meta.draft.slice(0, at), meta.draft.slice(at + 1));
    } catch {
      draft = undefined;
    }
    if (!draft) {
      return {
        entry: {
          ...base,
          ...info,
          status: "unreadable",
          limitation: "the pinned draft could not be read",
        },
      };
    }
    // The hash of the bytes actually read, not a name or a recorded claim.
    const hash = `sha256:${createHash("sha256").update(draft.content).digest("hex")}`;
    const verdict = reports.bound.get(`${draft.ref.repository}|${hash}`);
    let delivered: { receipts: ReceiptView[]; truncated: boolean } = {
      receipts: [],
      truncated: false,
    };
    if (receipts) {
      try {
        delivered = await receipts.receiptsFor(base, hash);
      } catch {
        delivered = { receipts: [], truncated: true };
      }
    }
    return {
      entry: {
        ...base,
        ...info,
        hash,
        // No verdict from a partial scan is "incomplete", never "unverified".
        status: verdict ?? (reports.incomplete ? "incomplete" : "unverified"),
        ...(!verdict && reports.incomplete
          ? { limitation: "the verification scan was incomplete or a report was unreadable" }
          : {}),
        receipts: delivered.receipts,
        ...(delivered.truncated ? { receiptsTruncated: true } : {}),
      },
      markdown: draft.content,
    };
  };

  return {
    async page({ after, publicationId, postId }) {
      const prefix =
        publicationId && ID.test(publicationId)
          ? postId && ID.test(postId)
            ? `articles/${publicationId}/${postId}`
            : `articles/${publicationId}`
          : "articles";
      // Over-read: metadata and Markdown share the prefix.
      const paths = await content.list(prefix, DRAFT_PAGE * 2, after);
      const metadata = paths.filter((p) => METADATA_PATH.test(p)).slice(0, DRAFT_PAGE);
      const reportCache = new Map<string, Awaited<ReturnType<typeof reportsFor>>>();
      const entries: DraftEntry[] = [];
      for (const path of metadata) {
        const m = METADATA_PATH.exec(path)!;
        const key = `${m[1]}/${m[2]}`;
        if (!reportCache.has(key)) reportCache.set(key, await reportsFor(m[1]!, m[2]!));
        entries.push((await entryFor(path, reportCache.get(key)!)).entry);
      }
      const last = metadata.length === DRAFT_PAGE ? metadata.at(-1) : undefined;
      const more = paths.length === DRAFT_PAGE * 2 ? paths.at(-1) : undefined;
      const next = last ?? more;
      return { entries, ...(next ? { next } : {}) };
    },
    async text(path) {
      const m = METADATA_PATH.exec(path);
      if (!m) return undefined;
      return entryFor(path, await reportsFor(m[1]!, m[2]!));
    },
  };
}
