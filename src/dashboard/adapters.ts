import * as clients from "@restatedev/restate-sdk-clients";
import { FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import type { OccurrenceSearchPort } from "../analysis/claim-timeline.js";
import { articleRunKey, type ArticleRunApi } from "../workflow/article-run.js";
import type { ArchivedArticle, RecentArticlesPort, RunState, RunStatusPort } from "./articles.js";

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
