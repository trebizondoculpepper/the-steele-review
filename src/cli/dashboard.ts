/**
 * LAN-only operator dashboard (#375, #377).
 *
 *   dashboard
 *
 * Serves the dashboard over HTTP. No login, by owner decision: restrict
 * exposure with the Compose port binding (STEELE_DASHBOARD_BIND), which is
 * configured privately. Reads are read-only; an explicitly configured origin
 * enables confirmed submission of one captured revision to ArticleRun.
 *
 * Configuration (environment), each optional; an unconfigured source is shown
 * as such on the page:
 *   STEELE_DASHBOARD_ORIGIN?                         exact browser origin enabling actions
 *   STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT?         server-side request bound (default 5)
 *   STEELE_DASHBOARD_RESEARCH_DEADLINE_MS?            server-side deadline (default 1800000)
 *   STEELE_DASHBOARD_PORT?                           listen port (default 8090)
 *   ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY[_FILE]? full-text index (article list)
 *   STEELE_FULLTEXT_INDEX?                           index name (default steele-source-text-v1)
 *   RESTATE_INGRESS_URL                              ArticleRun results
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY   captured-source archive (read only)
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   content repository (read only)
 *   STEELE_STATE_PATH?                               state-controller database (read only)
 *   NATS_URL, NATS_TOKEN[_FILE]?                     broker health
 *   STEELE_CATCHUP_CHECKPOINT_PATH?                  index catch-up checkpoint
 *   STEELE_DISCOVERY_STATUS_PATH?                    discovery runner status file
 *   STEELE_DASHBOARD_DESTINATIONS?                   comma-separated publisher destinations
 */
import { z } from "zod";
import { elasticsearchConnection, natsConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import { fileCheckpoint } from "../collection/catchup-checkpoint.js";
import { systemStatusSource } from "../dashboard/status-adapters.js";
import { statusView } from "../dashboard/status.js";
import { tracePost } from "../diagnostics/post-trace.js";
import { natsProbe, stateProbeFor } from "../diagnostics/runtime-status.js";
import {
  contentArticleView,
  contentReceipts,
  indexArticles,
  restateRuns,
  restateSubmitter,
} from "../dashboard/adapters.js";
import { articleTrigger } from "../dashboard/trigger.js";
import { articleViews } from "../dashboard/article-views.js";
import { createDashboardServer, DEFAULT_VIEWS } from "../dashboard/server.js";

const env = z
  .object({
    STEELE_DASHBOARD_PORT: z.coerce.number().int().min(1).max(65_535).default(8090),
    RESTATE_INGRESS_URL: z.url({ protocol: /^https?$/ }).optional(),
    STEELE_DASHBOARD_ORIGIN: z
      .url({ protocol: /^https?$/ })
      .refine((value) => value === new URL(value).origin)
      .optional(),
    STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT: z.coerce.number().int().min(0).max(100).default(5),
    STEELE_DASHBOARD_RESEARCH_DEADLINE_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(86400000)
      .default(1800000),
  })
  .safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
if (!env.success) {
  console.error("dashboard: invalid dashboard configuration");
  process.exit(2);
}
const e = process.env;
const store = (path?: string, repository?: string) =>
  path && repository ? new GitArtifactStore({ repoPath: path, repository }) : undefined;

let es: ElasticsearchController | undefined;
if (e.ELASTICSEARCH_URL) {
  try {
    const conn = elasticsearchConnection();
    es = new ElasticsearchController(conn.url, conn.apiKey);
  } catch {
    console.error("dashboard: Elasticsearch configuration is unusable");
    process.exit(2);
  }
}
const archive = store(e.STEELE_ARCHIVE_PATH, e.STEELE_ARCHIVE_REPOSITORY);
const content = store(e.STEELE_CONTENT_PATH, e.STEELE_CONTENT_REPOSITORY);

// Status probes reuse the same read-only controllers as the `status` command.
const state = e.STEELE_STATE_PATH ? stateProbeFor(e.STEELE_STATE_PATH) : undefined;
let nats;
try {
  const conn = e.NATS_URL ? natsConnection() : undefined;
  nats = conn ? natsProbe(conn) : undefined;
} catch {
  // Configured but unusable: the check reports unavailable rather than the
  // dashboard failing to start.
  nats = { check: async () => Promise.reject(new Error("configuration unusable")) };
}
const checkpoint = e.STEELE_CATCHUP_CHECKPOINT_PATH
  ? fileCheckpoint(e.STEELE_CATCHUP_CHECKPOINT_PATH)
  : undefined;

const trigger =
  archive && env.data.RESTATE_INGRESS_URL && env.data.STEELE_DASHBOARD_ORIGIN
    ? articleTrigger({
        archive,
        submitter: restateSubmitter(env.data.RESTATE_INGRESS_URL),
        researchRequestLimit: env.data.STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT,
        researchDeadlineMs: env.data.STEELE_DASHBOARD_RESEARCH_DEADLINE_MS,
      })
    : undefined;
const views = [
  DEFAULT_VIEWS[0]!,
  ...(trigger ? [trigger.view] : []),
  ...articleViews({
    canTrigger: Boolean(trigger),
    ...(es ? { articles: indexArticles(es, e.STEELE_FULLTEXT_INDEX || undefined) } : {}),
    ...(env.data.RESTATE_INGRESS_URL ? { runs: restateRuns(env.data.RESTATE_INGRESS_URL) } : {}),
    trace: (post) =>
      tracePost({
        post,
        // The same index probe as post-trace, so indexing lag shows as stale.
        ...(es
          ? {
              search: {
                fulltextSourceVersion: async (publicationId: string, postId: string) => {
                  const hits = await es!.search(
                    e.STEELE_FULLTEXT_INDEX || FULLTEXT_INDEX_V1,
                    { bool: { filter: [{ term: { publicationId } }, { term: { postId } }] } },
                    { size: 1 },
                  );
                  const v = (hits[0]?.source as { sourceVersion?: unknown } | undefined)
                    ?.sourceVersion;
                  return typeof v === "string" ? v : null;
                },
              },
            }
          : {}),
        ...(archive ? { archive } : {}),
        ...(content ? { content } : {}),
      }),
    ...(content
      ? {
          content: contentArticleView(content),
          receipts: contentReceipts(content, {
            destinations: (e.STEELE_DASHBOARD_DESTINATIONS ?? "")
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean),
          }),
        }
      : {}),
  }),
  statusView(
    systemStatusSource({
      runtime: {
        ...(state ? { state } : {}),
        ...(nats ? { nats } : {}),
        // Reuse the dashboard's search client rather than opening a second one.
        ...(es ? { elasticsearch: { check: (signal?: AbortSignal) => es.check(signal) } } : {}),
      },
      ...(archive ? { archive } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(e.STEELE_DISCOVERY_STATUS_PATH
        ? { discoveryStatusPath: e.STEELE_DISCOVERY_STATUS_PATH }
        : {}),
    }),
  ),
];

const server = createDashboardServer(
  views,
  trigger
    ? {
        origin: env.data.STEELE_DASHBOARD_ORIGIN!,
        routes: { "/articles/run": trigger.submit },
      }
    : undefined,
);
server.listen(env.data.STEELE_DASHBOARD_PORT, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      event: "dashboard",
      state: "serving",
      sources: {
        index: Boolean(es),
        runs: Boolean(env.data.RESTATE_INGRESS_URL),
        archive: Boolean(archive),
        content: Boolean(content),
      },
    }),
  );
});
const stop = () =>
  server.close(() => void Promise.resolve(es?.close()).finally(() => process.exit(0)));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
