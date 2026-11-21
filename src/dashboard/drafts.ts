import { createHash } from "node:crypto";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { PackageDraftMetadataSchema } from "../drafting/package-draft.js";
import {
  artifactReference,
  readPublicationPayload,
  sameArtifact,
} from "../drafting/publication-payload.js";
import { PackageVerificationReportSchema } from "../drafting/package-verify.js";
import type { ReceiptView, ReceiptsPort } from "./articles.js";
import type { DraftTrashStore } from "./draft-trash.js";

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
/** Bound on empty pages skipped while filtering trashed drafts (#478). */
export const MAX_FILTER_PAGES = 10;

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
  approvalScope?: "publication" | "body-only";
  publicationHash?: string;
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
type Binding = {
  outcome: "approved" | "redraft";
  publicationHash?: string;
  scope: "publication" | "body-only";
};
const metadataKey = (
  ref: { repository: string; commit: string; path: string; hash: string },
  bodyHash: string,
) => JSON.stringify([ref.repository, ref.commit, ref.path, ref.hash, bodyHash]);
const ID = /^[a-z0-9][a-z0-9-]{0,299}$/;

export function draftInventory(
  content: Store,
  receipts?: ReceiptsPort,
  trash?: Pick<DraftTrashStore, "states">,
): DraftInventoryPort {
  /**
   * Verification reports for one post, keyed by the exact draft they bind.
   * `incomplete` is set when the scan bound was reached or a listing or report
   * read failed: absence of a verdict then proves nothing.
   */
  const reportsFor = async (publicationId: string, postId: string) => {
    const bound = new Map<string, Binding>();
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
          const report = parsed.data;
          let key: string;
          let binding: Binding;
          if (report.schemaVersion === 2) {
            const { payload } = await readPublicationPayload(content, report.publication);
            if (!sameArtifact(payload.body, report.draft)) continue;
            key = metadataKey(payload.metadata, report.draft.hash);
            binding = {
              outcome: report.outcome,
              ...(payload.mode === "structured" ? { publicationHash: payload.contentHash } : {}),
              scope: payload.mode === "structured" ? "publication" : "body-only",
            };
          } else {
            key = `${report.draft.repository}|${report.draft.hash}`;
            binding = { outcome: report.outcome, scope: "body-only" };
          }
          if (bound.get(key)?.outcome !== "approved") bound.set(key, binding);
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
    reports: { bound: Map<string, Binding>; incomplete: boolean },
  ): Promise<{ entry: DraftEntry; markdown?: string }> => {
    const m = METADATA_PATH.exec(path)!;
    const base = { path, publicationId: m[1]!, postId: m[2]!, receipts: [] as ReceiptView[] };
    let meta;
    let metadataRef;
    try {
      const ref = await content.lookup(path);
      metadataRef = ref;
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
    const legacy = reports.bound.get(`${draft.ref.repository}|${hash}`);
    const binding = metadataRef
      ? reports.bound.get(metadataKey(artifactReference(metadataRef), hash))
      : undefined;
    const matched = binding ?? (meta.fields === undefined ? legacy : undefined);
    const verdict = matched?.outcome;
    const legacyMetadataGap = meta.fields !== undefined && !binding && legacy !== undefined;
    let delivered: { receipts: ReceiptView[]; truncated: boolean } = {
      receipts: [],
      truncated: false,
    };
    if (receipts && (binding || meta.fields === undefined)) {
      try {
        delivered = await receipts.receiptsFor(base, hash, matched?.publicationHash);
      } catch {
        delivered = { receipts: [], truncated: true };
      }
    }
    return {
      entry: {
        ...base,
        ...info,
        hash,
        ...(matched ? { approvalScope: matched.scope } : {}),
        ...(matched?.publicationHash ? { publicationHash: matched.publicationHash } : {}),
        ...(legacyMetadataGap
          ? { limitation: "legacy verification covers only the body, not these generated fields" }
          : {}),
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

  const buildPage = async (
    after: string | undefined,
    publicationId: string | undefined,
    postId: string | undefined,
  ): Promise<DraftPage> => {
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
    // Trashed drafts leave the active listing; their artifacts stay intact
    // and a restore marker brings them back (#478).
    // One history read for the whole page, not one per entry.
    const hidden = trash
      ? await trash.states(entries.map((e) => e.path))
      : new Map<string, "active" | "trashed">();
    return {
      entries: entries.filter((e) => hidden.get(e.path) !== "trashed"),
      ...(next ? { next } : {}),
    };
  };

  const port: DraftInventoryPort = {
    async page({ after, publicationId, postId }): Promise<DraftPage> {
      let cursor = after;
      // A storage page can be entirely trashed while later pages still hold
      // active drafts. Keep reading until something is visible or the listing
      // ends, bounded so a fully trashed archive cannot scan forever.
      for (let skipped = 0; skipped < MAX_FILTER_PAGES; skipped++) {
        const page = await buildPage(cursor, publicationId, postId);
        if (page.entries.length > 0 || !page.next) return page;
        cursor = page.next;
      }
      return { entries: [] };
    },
    async text(path: string) {
      const m = METADATA_PATH.exec(path);
      if (!m) return undefined;
      return entryFor(path, await reportsFor(m[1]!, m[2]!));
    },
  };
  return port;
}
