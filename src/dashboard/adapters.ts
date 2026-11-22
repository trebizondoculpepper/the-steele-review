import type { OperationStore } from "../controllers/operation-store.js";
import { readPublicationPayload, sameArtifact } from "../drafting/publication-payload.js";
import * as clients from "@restatedev/restate-sdk-clients";
import { FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import type { OccurrenceSearchPort } from "../analysis/claim-timeline.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { articleRunKey, type ArticleRunApi } from "../workflow/article-run.js";
import { isCreditBlocked } from "./article-views.js";
import { recoveryWorkflowKey } from "./recovery.js";
import { DeliveryReceiptSchema } from "../publishing/approved-article.js";
import { PackageVerificationReportSchema } from "../drafting/package-verify.js";
import { z } from "zod";
import { CollectionRecordSchema } from "../collection/collection-store.js";
import { collectionArtifactPath } from "../collection/collection-store.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import type {
  ArchivedArticle,
  ArticleContentPort,
  CapturedSource,
  ReceiptView,
  ReceiptsPort,
  SourcePort,
  RecentArticlesPort,
  RunState,
  RunStatusPort,
} from "./articles.js";
import type { Ref } from "../workflow/article-run.js";

/** Missing-date sort values in epoch milliseconds: year 0001 and the end of 9999 (#721). */
export const MIN_DATE_MS = Date.parse("0001-01-01T00:00:00.000Z");
export const MAX_DATE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** Recent articles from the full-text index, newest publication first (#377). */
export function indexArticles(
  search: OccurrenceSearchPort,
  index = FULLTEXT_INDEX_V1,
): RecentArticlesPort {
  const toArticle = (source: unknown): ArchivedArticle | undefined => {
    const s = source as Record<string, unknown>;
    if (typeof s.publicationId !== "string" || typeof s.postId !== "string") return undefined;
    if (typeof s.sourceVersion !== "string") return undefined;
    return {
      publicationId: s.publicationId,
      postId: s.postId,
      sourceVersion: s.sourceVersion,
      ...(typeof s.title === "string" ? { title: s.title } : {}),
      ...(typeof s.publishedAt === "string" ? { publishedAt: s.publishedAt } : {}),
    };
  };
  return {
    async recent(limit) {
      const hits = await search.search(
        index,
        { match_all: {} },
        { size: limit, sort: [{ publishedAt: { order: "desc", missing: "_last" } }] },
      );
      return hits.map((h) => toArticle(h.source)).filter((a): a is ArchivedArticle => Boolean(a));
    },
    async page({ sort, after, limit, query, publicationId }) {
      // Tie-break on stable source identity so a page boundary cannot repeat or
      // skip a row when several posts share a publication date.
      const order = sort === "newest" ? "desc" : "asc";
      // Undated articles go last in both orders, as in `recent`. Not
      // `_last`/`_first`: Elasticsearch then sorts by a 64-bit integer that
      // JavaScript cannot round-trip through a JSON cursor. Not an ISO date
      // string either: Elasticsearch rejects that as a missing value (#721).
      // Epoch milliseconds are accepted, come back as the hit's sort value,
      // and stay within JavaScript's safe integer range.
      const missingDate = sort === "newest" ? MIN_DATE_MS : MAX_DATE_MS;
      const esSort = [
        { publishedAt: { order, missing: missingDate } },
        { publicationId: { order: "asc" } },
        { postId: { order: "asc" } },
      ];
      let searchAfter: unknown[] | undefined;
      if (after) {
        try {
          const parsed = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
          if (Array.isArray(parsed)) searchAfter = parsed;
        } catch {
          // A malformed cursor restarts from the first page rather than failing.
          searchAfter = undefined;
        }
      }
      // Search over the whole index (#509): user text is plain words, never
      // query-string syntax; the publication is an exact term filter.
      const words = query?.trim().slice(0, 200);
      const must = words
        ? [{ multi_match: { query: words, fields: ["title^2", "text"], operator: "and" } }]
        : [{ match_all: {} }];
      const filter = publicationId ? [{ term: { publicationId } }] : [];
      const hits = await search.search(index, { bool: { must, filter } }, {
        size: limit,
        sort: esSort,
        ...(searchAfter ? { searchAfter } : {}),
      } as { size?: number; sort?: unknown; searchAfter?: unknown[] });
      const entries = hits
        .map((h) => toArticle(h.source))
        .filter((a): a is ArchivedArticle => Boolean(a));
      const last = hits[hits.length - 1] as { sort?: unknown[] } | undefined;
      const next =
        hits.length === limit && last?.sort
          ? Buffer.from(JSON.stringify(last.sort)).toString("base64url")
          : undefined;
      return { entries, ...(next ? { next } : {}) };
    },
    async find(publicationId, postId) {
      const hits = await search.search(
        index,
        { bool: { filter: [{ term: { publicationId } }, { term: { postId } }] } },
        { size: 1 },
      );
      return hits[0] ? toArticle(hits[0].source) : undefined;
    },
  };
}

/** Terminal wrapper written when redraft attempts are exhausted. */
const UnresolvedVerificationSchema = z
  .object({
    outcome: z.literal("unresolved"),
    revisions: z.number().int().min(0),
    report: z
      .object({ repository: z.string(), commit: z.string(), path: z.string(), hash: z.string() })
      .strict(),
    issues: z.array(z.unknown()),
  })
  .strict();

const persistedRef = (r: {
  repository: string;
  commit: string;
  path: string;
  hash: string;
}): Ref => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.hash.replace(/^sha256:/, ""),
});

/** Bound on retained capture text shown on one page. */
export const SOURCE_DISPLAY_CHARS = 20_000;

/**
 * Retained captured source through the artifact controller (#446). The record
 * is read once at the archive's pinned blob; nothing is fetched again and no
 * deployment path leaves this function.
 */
export function archivedSource(
  archive: Pick<GitArtifactStore, "list" | "lookup" | "read">,
  options: { maxChars?: number } = {},
): SourcePort {
  const maxChars = options.maxChars ?? SOURCE_DISPLAY_CHARS;
  return {
    async read(post, expectedSourceVersion): Promise<CapturedSource> {
      try {
        // lookup() treats an unreadable repository as "no branch yet"; list()
        // fails instead, so probe first to tell broken storage from absence.
        await archive.list("substack", 1);
        const ref = await archive.lookup(collectionArtifactPath(post));
        if (!ref) return { state: "missing" };
        const record = CollectionRecordSchema.parse(JSON.parse(await archive.read(ref)));
        const sourceVersion = sourceVersionFor(record.text);
        const text = record.text.slice(0, maxChars);
        return {
          state: "recorded",
          ...(record.item.title ? { title: record.item.title } : {}),
          ...(record.item.url.startsWith("https://") ? { url: record.item.url } : {}),
          method: record.provenance.method,
          complete: record.complete,
          sourceVersion,
          revision: `${ref.commit.slice(0, 12)}:${ref.path}`,
          text,
          truncated: record.text.length > text.length,
          matchesRevision:
            expectedSourceVersion === undefined ? null : expectedSourceVersion === sourceVersion,
        };
      } catch {
        return { state: "unreadable" };
      }
    },
  };
}

/** Saved drafts and verification reports, read at their exact pinned revision. */
export function contentArticleView(content: Pick<GitArtifactStore, "read">): ArticleContentPort {
  const read = async (ref: Ref): Promise<string | undefined> => {
    try {
      return await content.read(ref);
    } catch {
      return undefined;
    }
  };
  const readReport = async (
    ref: Ref,
  ): Promise<{ outcome: string; draftHash?: string; publicationHash?: string } | undefined> => {
    const text = await read(ref);
    if (text === undefined) return undefined;
    try {
      const report = PackageVerificationReportSchema.parse(JSON.parse(text));
      let publicationHash: string | undefined;
      if (report.schemaVersion === 2) {
        const { payload } = await readPublicationPayload(content, report.publication);
        if (!sameArtifact(payload.body, report.draft)) return undefined;
        if (payload.mode === "structured") publicationHash = payload.contentHash;
      }
      return {
        outcome: report.outcome,
        draftHash: report.draft.hash,
        ...(publicationHash ? { publicationHash } : {}),
      };
    } catch {
      return undefined;
    }
  };
  return {
    draft: read,
    async verification(ref) {
      const direct = await readReport(ref);
      if (direct) return direct;
      const text = await read(ref);
      if (text === undefined) return undefined;
      try {
        // An exhausted redraft loop saves a wrapper whose pinned report holds
        // the terminal verdict; show that rather than omitting verification.
        const wrapper = UnresolvedVerificationSchema.parse(JSON.parse(text));
        const report = await readReport(persistedRef(wrapper.report));
        if (report) return { ...report, outcome: wrapper.outcome };
        return { outcome: wrapper.outcome };
      } catch {
        return undefined;
      }
    },
  };
}

/** Page size and scan bound for receipt enumeration. */
export const RECEIPT_PAGE = 500;
export const RECEIPT_MAX_PAGES = 20;
/** Bound on receipts returned for one article view. */
export const RECEIPT_LIMIT = 20;

const RECEIPT_PATH =
  /^publications\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([0-9a-f]{32})\/receipt\.json$/;

export interface ReceiptScanOptions {
  /** Maximum receipts to return; defaults to RECEIPT_LIMIT. */
  limit?: number;
  /**
   * Known destination names. When present the scan is scoped to those
   * destinations, so an unrelated backlog cannot crowd out an article's
   * receipts; otherwise the whole publications tree is paginated and the
   * result is marked truncated if the scan bound is reached.
   */
  destinations?: string[];
}

/**
 * Publisher receipts recorded for one article (#378). A simulated receipt is
 * always labelled; a link is exposed only for a confirmed real delivery.
 */
export function contentReceipts(
  content: Pick<GitArtifactStore, "list" | "lookup" | "read">,
  options: ReceiptScanOptions = {},
): ReceiptsPort {
  const limit = options.limit ?? RECEIPT_LIMIT;
  const prefixes = (options.destinations ?? [])
    .filter((name) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(name))
    .map((name) => `publications/${name}`);
  return {
    async receiptsFor(post, draftHash, publicationHash) {
      const fullHash = draftHash?.replace(/^sha256:/, "");
      if (fullHash !== undefined && !/^[0-9a-f]{64}$/.test(fullHash)) {
        return { receipts: [], truncated: false };
      }
      if (publicationHash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(publicationHash))
        return { receipts: [], truncated: false };
      const revision = (publicationHash?.slice(7) ?? fullHash)?.slice(0, 32);
      const receipts: ReceiptView[] = [];
      let truncated = false;

      const scanPrefix = async (prefix: string): Promise<void> => {
        let after: string | undefined;
        for (let page = 0; page < RECEIPT_MAX_PAGES; page++) {
          const paths = await content.list(prefix, RECEIPT_PAGE, after);
          for (const path of paths) {
            const match = RECEIPT_PATH.exec(path);
            if (!match) continue;
            const [, destination, action, publicationId, postId, rev] = match;
            if (publicationId !== post.publicationId || postId !== post.postId) continue;
            if (revision && rev !== revision) continue;
            if (receipts.length >= limit) {
              truncated = true;
              return;
            }
            try {
              const ref = await content.lookup(path);
              if (!ref) continue;
              const receipt = DeliveryReceiptSchema.parse(JSON.parse(await content.read(ref)));
              // A path is only a candidate: bind the payload to its destination,
              // action and full draft hash before presenting delivery evidence.
              const receiptHash = receipt.draftHash?.replace(/^sha256:/, "");
              if (
                receipt.destination !== destination ||
                receipt.action !== action ||
                receiptHash === undefined ||
                (receipt.publicationHash?.slice(7) ?? receiptHash).slice(0, 32) !== rev ||
                receipt.publicationHash !== publicationHash ||
                (fullHash !== undefined && receiptHash !== fullHash)
              )
                continue;
              const confirmed =
                !receipt.simulated &&
                typeof receipt.url === "string" &&
                receipt.url.startsWith("https://");
              receipts.push({
                destination: receipt.destination,
                action: receipt.action,
                simulated: receipt.simulated,
                deliveredAt: receipt.deliveredAt,
                ...(confirmed ? { url: receipt.url } : {}),
              });
            } catch {
              // An unreadable receipt is omitted, never guessed.
            }
          }
          if (paths.length < RECEIPT_PAGE) return;
          after = paths[paths.length - 1];
        }
        // The bound was reached before the prefix was exhausted.
        truncated = true;
      };

      if (prefixes.length > 0) {
        for (let index = 0; index < prefixes.length; index++) {
          await scanPrefix(prefixes[index]!);
          if (receipts.length >= limit) {
            // Destinations after this one were never scanned.
            if (index < prefixes.length - 1) truncated = true;
            break;
          }
        }
      } else {
        await scanPrefix("publications");
      }
      return { receipts, truncated };
    },
  };
}

/** ArticleRun status for an exact revision, read through Restate ingress. */
export function restateRuns(
  ingressUrl: string,
  timeoutMs = 5_000,
  attempts?: Pick<OperationStore, "articleAttempts">,
  connect: typeof clients.connect = clients.connect,
): RunStatusPort {
  const ingress = connect({ url: ingressUrl });
  const read = async (key: string): Promise<RunState> => {
    const workflow = ingress.workflowClient<ArticleRunApi>({ name: "ArticleRun" }, key);
    try {
      const out = await workflow.workflowOutput(
        clients.rpc.opts({ signal: AbortSignal.timeout(timeoutMs) }),
      );
      if (out.ready) return { state: "finished", result: out.result };
      // Running: read the run's own progress (#439). A failed read is shown as
      // unavailable progress, never as success.
      try {
        const progress = await workflow.progress(
          clients.rpc.opts({ signal: AbortSignal.timeout(timeoutMs) }),
        );
        return { state: "running", progress };
      } catch {
        return { state: "running" };
      }
    } catch (error) {
      if (error instanceof clients.HttpCallError && error.status === 404) {
        return { state: "not-started" };
      }
      return { state: "unavailable" };
    }
  };
  return {
    async status(post): Promise<RunState> {
      const normal = await read(articleRunKey(post));
      const recorded =
        attempts?.articleAttempts(post.publicationId, post.postId, post.sourceVersion, 10) ?? [];
      if (recorded.length) {
        const current = recorded[0]!;
        const selected = await read(current.workflowKey);
        const recovery =
          selected.state === "finished" && isCreditBlocked(selected.result.reason)
            ? await read(recoveryWorkflowKey(current.workflowKey))
            : undefined;
        return {
          ...selected,
          ...(recovery && recovery.state !== "not-started" ? { recovery } : {}),
          workflowKey: current.workflowKey,
          attempts: recorded,
        };
      }
      // A credit-stopped run may have an explicit recovery (#480): show the
      // original failure and the recovery state together, never one as the other.
      if (normal.state === "finished" && isCreditBlocked(normal.result.reason)) {
        const recovery = await read(recoveryWorkflowKey(articleRunKey(post)));
        if (recovery.state !== "not-started") return { ...normal, recovery };
      }
      return normal;
    },
  };
}

/** Submit through the same Restate identity as automatic capture and the CLI. */
export function restateSubmitter(
  ingressUrl: string,
  connect: typeof clients.connect = clients.connect,
) {
  const ingress = connect({ url: ingressUrl });
  return {
    async submit(
      input: import("../workflow/article-run.js").ArticleRunInput,
      workflowKey?: string,
    ): Promise<void> {
      // An explicit recovery supplies its own durable key (#480); ordinary
      // submissions keep the stable identity shared with the CLI and ingress.
      await ingress
        .workflowClient<ArticleRunApi>({ name: "ArticleRun" }, workflowKey ?? articleRunKey(input))
        .workflowSubmit(input, clients.rpc.sendOpts({ signal: AbortSignal.timeout(10_000) }));
    },
  };
}
