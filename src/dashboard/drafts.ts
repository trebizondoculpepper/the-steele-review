import { CommitRecordSchema, type ArticleCommitRecord } from "../drafting/article-revisions.js";
import { createHash } from "node:crypto";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
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
/** A logical article's canonical metadata: its one row in the inventory (#581). */
const CANONICAL_PATH = /^articles\/([^/]+)\/([^/]+)\/(article-[0-9a-f]{24})\/article\.json$/;
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
  /** The logical article this draft is a version of (#581), when it was committed to one. */
  article?: { id: string; version: number; current: boolean };
}

/** One logical article with its ordered versions (#581). */
export interface ArticleHistory {
  id: string;
  publicationId: string;
  postId: string;
  /** Hash of the canonical body now; undefined when it cannot be read. */
  currentHash?: string;
  versions: {
    version: number;
    current: boolean;
    /** Commit holding this version of the canonical body. */
    commit: string;
    entry: DraftEntry;
  }[];
  /** Commit records that could not be read or ordered. */
  unreadable: number;
  /** The listing was cut off, so earlier versions may be missing. */
  incomplete?: boolean;
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
  /** One logical article's version history, oldest first (#581). */
  article(publicationId: string, postId: string, id: string): Promise<ArticleHistory | undefined>;
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

  /**
   * One draft's entry. With `pinned`, a committed article version is read from
   * the exact body and metadata its commit record pins, so it stays readable
   * after the generation files are removed from the branch (#581); its
   * verdict still binds the generation the verifier saw.
   */
  const entryFor = async (
    path: string,
    reports: { bound: Map<string, Binding>; incomplete: boolean },
    pinned?: ArticleCommitRecord,
  ): Promise<{ entry: DraftEntry; markdown?: string }> => {
    const m = METADATA_PATH.exec(path)!;
    const base = { path, publicationId: m[1]!, postId: m[2]!, receipts: [] as ReceiptView[] };
    let meta;
    let metadataRef: ArtifactRef | undefined;
    try {
      const ref = pinned ? pinned.metadata : await content.lookup(path);
      if (!ref) throw new Error("missing");
      meta = PackageDraftMetadataSchema.parse(JSON.parse(await content.read(ref)));
      metadataRef = pinned ? pinned.generation.metadata : ref;
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
    let draft: { ref: { repository: string }; content: string } | undefined;
    try {
      draft = pinned
        ? { ref: pinned.body, content: await content.read(pinned.body) }
        : await content.lookupAt(meta.draft.slice(0, at), meta.draft.slice(at + 1));
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

  /**
   * Versions of every logical article of one post, from the write-once commit
   * records #579 saves: each names the exact generation draft, and its base
   * links it to the version it replaced. Ordered by that chain.
   */
  const historiesFor = async (publicationId: string, postId: string) => {
    const byArticle = new Map<string, ArticleCommitRecord[]>();
    let unreadable = 0;
    const paths: string[] = [];
    let complete = true;
    try {
      // Follow the listing to the end, bounded; a cut-off history is reported.
      let after: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= 20) {
          complete = false;
          break;
        }
        const batch = await content.list(`articles/${publicationId}/${postId}`, 1000, after);
        paths.push(...batch);
        if (batch.length < 1000) break;
        after = batch.at(-1);
      }
    } catch {
      return { byArticle, unreadable: 1, complete: false };
    }
    for (const path of paths) {
      const m = /\/(article-[0-9a-f]{24})\/commits\/[0-9a-f]{32}\.json$/.exec(path);
      if (!m) continue;
      try {
        const ref = await content.lookup(path);
        if (!ref) continue;
        const record = CommitRecordSchema.parse(JSON.parse(await content.read(ref)));
        byArticle.set(m[1]!, [...(byArticle.get(m[1]!) ?? []), record]);
      } catch {
        unreadable++;
      }
    }
    const ordered = new Map<string, ArticleCommitRecord[]>();
    for (const [id, records] of byArticle) {
      const chain: ArticleCommitRecord[] = [];
      // A version is its body AND metadata: chain on both base hashes, so a
      // metadata-only revision is never skipped or misordered.
      const pair = (body: string | null, metadata: string | null) => `${body}|${metadata}`;
      const versions = new Set(records.map((r) => pair(r.body.sha256, r.metadata.sha256)));
      let next = records.find((r) => !versions.has(pair(r.base.body, r.base.metadata)));
      const seen = new Set<ArticleCommitRecord>();
      while (next && !seen.has(next)) {
        seen.add(next);
        chain.push(next);
        const at = pair(next.body.sha256, next.metadata.sha256);
        next = records.find((r) => !seen.has(r) && pair(r.base.body, r.base.metadata) === at);
      }
      unreadable += records.length - chain.length;
      ordered.set(id, chain);
    }
    return { byArticle: ordered, unreadable, complete };
  };

  /** Canonical body and metadata hashes of a logical article now, if readable. */
  const currentHash = async (publicationId: string, postId: string, id: string) => {
    try {
      const dir = `articles/${publicationId}/${postId}/${id}`;
      const body = (await content.lookup(`${dir}/article.md`))?.sha256;
      const metadata = (await content.lookup(`${dir}/article.json`))?.sha256;
      return body && metadata ? `${body}|${metadata}` : undefined;
    } catch {
      return undefined;
    }
  };
  /** True only when both canonical documents are exactly this version's. */
  const isCurrent = (r: ArticleCommitRecord, head: string | undefined) =>
    head !== undefined && `${r.body.sha256}|${r.metadata.sha256}` === head;

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
    const metadata = paths
      .filter((p) => METADATA_PATH.test(p) || CANONICAL_PATH.test(p))
      .slice(0, DRAFT_PAGE);
    const reportCache = new Map<string, Awaited<ReturnType<typeof reportsFor>>>();
    const entries: DraftEntry[] = [];
    // Per post: each logical article's chain and current head, and which
    // generation drafts belong to one (those appear only through it) (#581).
    const historyCache = new Map<
      string,
      { chains: Map<string, ArticleCommitRecord[]>; heads: Map<string, string | undefined> }
    >();
    const members = new Set<string>();
    for (const path of metadata) {
      const m = (METADATA_PATH.exec(path) ?? CANONICAL_PATH.exec(path))!;
      const key = `${m[1]}/${m[2]}`;
      if (!reportCache.has(key)) reportCache.set(key, await reportsFor(m[1]!, m[2]!));
      if (!historyCache.has(key)) {
        const { byArticle } = await historiesFor(m[1]!, m[2]!);
        const heads = new Map<string, string | undefined>();
        for (const [id, chain] of byArticle) {
          heads.set(id, await currentHash(m[1]!, m[2]!, id));
          for (const r of chain) members.add(r.generation.metadata.path);
        }
        historyCache.set(key, { chains: byArticle, heads });
      }
      const reports = reportCache.get(key)!;
      const canonical = CANONICAL_PATH.exec(path);
      if (!canonical) {
        // A generation committed to an article is shown as that article.
        if (members.has(path)) continue;
        entries.push((await entryFor(path, reports)).entry);
        continue;
      }
      const id = canonical[3]!;
      const { chains, heads } = historyCache.get(key)!;
      const chain = chains.get(id) ?? [];
      const at = chain.findIndex((r) => isCurrent(r, heads.get(id)));
      const shown = at >= 0 ? at : chain.length - 1;
      const record = chain[shown];
      if (!record) {
        entries.push({
          path,
          publicationId: m[1]!,
          postId: m[2]!,
          receipts: [],
          status: "unreadable",
          limitation: "this article's version records could not be read",
        });
        continue;
      }
      const { entry } = await entryFor(record.generation.metadata.path, reports, record);
      entries.push({
        ...entry,
        ...(at < 0
          ? { limitation: "the current canonical version could not be matched to a saved version" }
          : {}),
        article: { id, version: shown + 1, current: at >= 0 },
      });
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
      // Bound reached with nothing visible yet (trashed drafts, or generations
      // shown through their article): hand back the cursor so later pages
      // stay reachable instead of ending the listing early.
      return { entries: [], ...(cursor ? { next: cursor } : {}) };
    },
    async article(publicationId, postId, id) {
      if (!ID.test(publicationId) || !ID.test(postId) || !/^article-[0-9a-f]{24}$/.test(id)) {
        return undefined;
      }
      const { byArticle, unreadable, complete } = await historiesFor(publicationId, postId);
      const chain = byArticle.get(id);
      if (!chain) return undefined;
      const reports = await reportsFor(publicationId, postId);
      const head = await currentHash(publicationId, postId, id);
      const versions = [];
      for (const [i, r] of chain.entries()) {
        const { entry } = await entryFor(r.generation.metadata.path, reports, r);
        const current = isCurrent(r, head);
        versions.push({
          version: i + 1,
          current,
          // The commit holding this whole version: the one that changed a document.
          commit: r.base.body === r.body.sha256 ? r.metadata.commit : r.body.commit,
          entry: { ...entry, article: { id, version: i + 1, current } },
        });
      }
      return {
        id,
        publicationId,
        postId,
        ...(head ? { currentHash: head } : {}),
        versions,
        unreadable,
        ...(complete ? {} : { incomplete: true }),
      };
    },
    async text(path: string) {
      const m = METADATA_PATH.exec(path);
      if (!m) return undefined;
      const reports = await reportsFor(m[1]!, m[2]!);
      const { byArticle } = await historiesFor(m[1]!, m[2]!);
      for (const [id, chain] of byArticle) {
        const i = chain.findIndex((r) => r.generation.metadata.path === path);
        if (i < 0) continue;
        // A committed version reads the exact bytes its record pins (#581).
        const found = await entryFor(path, reports, chain[i]);
        const head = await currentHash(m[1]!, m[2]!, id);
        return {
          ...found,
          entry: {
            ...found.entry,
            article: { id, version: i + 1, current: isCurrent(chain[i]!, head) },
          },
        };
      }
      return entryFor(path, reports);
    },
  };
  return port;
}
