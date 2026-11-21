import * as clients from "@restatedev/restate-sdk-clients";
import { FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import type { OccurrenceSearchPort } from "../analysis/claim-timeline.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { articleRunKey, type ArticleRunApi } from "../workflow/article-run.js";
import { DeliveryReceiptSchema } from "../publishing/approved-article.js";
import { PackageVerificationReportSchema } from "../drafting/package-verify.js";
import { z } from "zod";
import type {
  ArchivedArticle,
  ArticleContentPort,
  ReceiptView,
  ReceiptsPort,
  RecentArticlesPort,
  RunState,
  RunStatusPort,
} from "./articles.js";
import type { Ref } from "../workflow/article-run.js";

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
  ): Promise<{ outcome: string; draftHash?: string } | undefined> => {
    const text = await read(ref);
    if (text === undefined) return undefined;
    try {
      const report = PackageVerificationReportSchema.parse(JSON.parse(text));
      return { outcome: report.outcome, draftHash: report.draft.hash };
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
        if (report) return { outcome: wrapper.outcome, draftHash: report.draftHash };
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
    async receiptsFor(post, draftHash) {
      const fullHash = draftHash?.replace(/^sha256:/, "");
      if (fullHash !== undefined && !/^[0-9a-f]{64}$/.test(fullHash)) {
        return { receipts: [], truncated: false };
      }
      const revision = fullHash?.slice(0, 32);
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
                receiptHash.slice(0, 32) !== rev ||
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
export function restateRuns(ingressUrl: string, timeoutMs = 5_000): RunStatusPort {
  const ingress = clients.connect({ url: ingressUrl });
  return {
    async status(post): Promise<RunState> {
      const workflow = ingress.workflowClient<ArticleRunApi>(
        { name: "ArticleRun" },
        articleRunKey(post),
      );
      try {
        const out = await workflow.workflowOutput(
          clients.rpc.opts({ signal: AbortSignal.timeout(timeoutMs) }),
        );
        return out.ready ? { state: "finished", result: out.result } : { state: "running" };
      } catch (error) {
        if (error instanceof clients.HttpCallError && error.status === 404) {
          return { state: "not-started" };
        }
        return { state: "unavailable" };
      }
    },
  };
}

/** Submit through the same Restate identity as automatic capture and the CLI. */
export function restateSubmitter(ingressUrl: string) {
  const ingress = clients.connect({ url: ingressUrl });
  return {
    async submit(input: import("../workflow/article-run.js").ArticleRunInput): Promise<void> {
      await ingress
        .workflowClient<ArticleRunApi>({ name: "ArticleRun" }, articleRunKey(input))
        .workflowSubmit(input, clients.rpc.sendOpts({ signal: AbortSignal.timeout(10_000) }));
    },
  };
}
