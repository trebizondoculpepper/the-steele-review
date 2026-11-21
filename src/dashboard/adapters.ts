import * as clients from "@restatedev/restate-sdk-clients";
import { FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import type { OccurrenceSearchPort } from "../analysis/claim-timeline.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { articleRunKey, type ArticleRunApi } from "../workflow/article-run.js";
import { DeliveryReceiptSchema } from "../publishing/approved-article.js";
import { PackageVerificationReportSchema } from "../drafting/package-verify.js";
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

/** Saved drafts and verification reports, read at their exact pinned revision. */
export function contentArticleView(
  content: Pick<GitArtifactStore, "lookupAt">,
): ArticleContentPort {
  const read = async (ref: Ref): Promise<string | undefined> => {
    try {
      const found = await content.lookupAt(ref.commit, ref.path);
      if (!found || found.ref.sha256 !== ref.sha256) return undefined;
      return found.content;
    } catch {
      return undefined;
    }
  };
  return {
    draft: read,
    async verification(ref) {
      const text = await read(ref);
      if (text === undefined) return undefined;
      try {
        const report = PackageVerificationReportSchema.parse(JSON.parse(text));
        return { outcome: report.outcome, draftHash: report.draft.hash };
      } catch {
        return undefined;
      }
    },
  };
}

/** Bound on receipts read for one article view. */
export const RECEIPT_LIMIT = 20;
/** Bound on the publication listing a receipt scan starts from. */
export const RECEIPT_SCAN_LIMIT = 2_000;

const RECEIPT_PATH = /^publications\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([0-9a-f]{32})\/receipt\.json$/;

/**
 * Publisher receipts recorded for one article (#378). A simulated receipt is
 * always labelled; a link is exposed only for a confirmed real delivery.
 */
export function contentReceipts(
  content: Pick<GitArtifactStore, "list" | "lookup" | "read">,
): ReceiptsPort {
  return {
    async receiptsFor(post, draftHash): Promise<ReceiptView[]> {
      const revision = draftHash?.replace(/^sha256:/, "").slice(0, 32);
      const paths = await content.list("publications", RECEIPT_SCAN_LIMIT);
      const receipts: ReceiptView[] = [];
      for (const path of paths) {
        const match = RECEIPT_PATH.exec(path);
        if (!match) continue;
        const [, , , publicationId, postId, rev] = match;
        if (publicationId !== post.publicationId || postId !== post.postId) continue;
        if (revision && rev !== revision) continue;
        if (receipts.length >= RECEIPT_LIMIT) break;
        try {
          const ref = await content.lookup(path);
          if (!ref) continue;
          const receipt = DeliveryReceiptSchema.parse(JSON.parse(await content.read(ref)));
          const confirmed =
            !receipt.simulated && typeof receipt.url === "string" && receipt.url.startsWith("https://");
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
      return receipts;
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
