import { editorialPolicyFromEnv } from "../workflow/editorial-contract.js";
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
 *   STEELE_RESTATE_UI_URL?                           Restate execution UI base, linked externally (#561)
 *   STEELE_RESTATE_ADMIN_URL?                        Restate admin API, to resolve exact invocations
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY   captured-source archive (read only)
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   content repository (read only)
 *   STEELE_STATE_PATH?                               state-controller database (read only)
 *   NATS_URL, NATS_TOKEN[_FILE]?                     broker health
 *   STEELE_CATCHUP_CHECKPOINT_PATH?                  index catch-up checkpoint
 *   STEELE_DISCOVERY_STATUS_PATH?                    discovery runner status file
 *   STEELE_DASHBOARD_DESTINATIONS?                   comma-separated publisher destinations
 */
import { corpusRefinementAction } from "../dashboard/corpus-refinement.js";
import { corpusRefinementSubmitter } from "../corpus-refinement/submission.js";
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
  archivedSource,
  contentArticleView,
  contentReceipts,
  indexArticles,
  restateRuns,
  restateSubmitter,
} from "../dashboard/adapters.js";
import { articleTrigger } from "../dashboard/trigger.js";
import { refetchAction, refetchView } from "../dashboard/refetch.js";
import { articleRecovery } from "../dashboard/recovery-view.js";
import { recoveryIdentities } from "../dashboard/recovery.js";
import { OperationStore } from "../controllers/operation-store.js";
import { articleViews } from "../dashboard/article-views.js";
import { draftViews } from "../dashboard/draft-views.js";
import { draftInventory } from "../dashboard/drafts.js";
import { themeViews } from "../dashboard/theme-views.js";
import { savedThemes } from "../dashboard/themes.js";
import { researchViews } from "../dashboard/research-views.js";
import { savedResearch } from "../dashboard/research.js";
import { claimViews } from "../dashboard/claim-views.js";
import { savedClaims } from "../dashboard/claims.js";
import { savedReviews } from "../dashboard/reviews.js";
import { reviewViews } from "../dashboard/review-views.js";
import { dossierViews } from "../dashboard/dossier-views.js";
import { savedEquivalence } from "../dashboard/equivalence.js";
import { equivalenceViews } from "../dashboard/equivalence-views.js";
import { mappingViews } from "../dashboard/mapping-views.js";
import { writerBrowseViews } from "../dashboard/writer-browse-views.js";
import { reviewsBrowseViews } from "../dashboard/reviews-browse-views.js";
import { articlesBrowseViews } from "../dashboard/articles-browse-views.js";
import { themesBrowseViews } from "../dashboard/themes-browse-views.js";
import { savedAssessments } from "../dashboard/assessments.js";
import { assessmentViews } from "../dashboard/assessment-views.js";
import { savedJudgments } from "../dashboard/judgments.js";
import { judgmentViews } from "../dashboard/judgment-views.js";
import { researchBrowseViews } from "../dashboard/research-browse-views.js";
import { claimBrowseViews } from "../dashboard/claim-browse-views.js";
import { DraftTrashStore } from "../dashboard/draft-trash.js";
import { collectActivity, renderActivity } from "../dashboard/activity.js";
import { currentConfigPage, renderConfigForm } from "../dashboard/config-view.js";
import { configEditAction, savedVersionOf } from "../dashboard/config-edit.js";
import { listSettingsRevisions, readSettingsFile } from "../config/settings-file.js";
import { inspectSettings, resolveSettings } from "../config/settings.js";
import { createDashboardServer } from "../dashboard/server.js";
import { restateRunIndex, restateInvocations, restateUiLinks } from "../dashboard/restate-links.js";

const env = z
  .object({
    STEELE_DASHBOARD_PORT: z.coerce.number().int().min(1).max(65_535).default(8090),
    RESTATE_INGRESS_URL: z.url({ protocol: /^https?$/ }).optional(),
    // Compose passes unset values as "": treat that as not configured.
    STEELE_RESTATE_UI_URL: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.url({ protocol: /^https?$/ }).optional(),
    ),
    STEELE_RESTATE_ADMIN_URL: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.url({ protocol: /^https?$/ }).optional(),
    ),
    STEELE_DASHBOARD_ORIGIN: z
      .url({ protocol: /^https?$/ })
      .refine((value) => value === new URL(value).origin)
      .optional(),
    /** "1" enables the draft trash action; the content mount must be writable. */
    STEELE_DASHBOARD_TRASH: z.enum(["0", "1"]).optional(),
    /** "1" enables the single-source re-fetch action (#770). */
    STEELE_DASHBOARD_REFETCH: z.enum(["0", "1"]).optional(),
    /** Saved configuration file the console may edit, when editing is enabled. */
    STEELE_CONFIG_PATH: z.string().min(1).optional(),
    /** Private salt the configuration version tokens are keyed on. */
    STEELE_CONFIG_VERSION_SALT: z.string().min(1).optional(),
    /** "1" enables the configuration edit form and its action. */
    STEELE_CONFIG_EDIT: z.enum(["0", "1"]).optional(),
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

// Durable operation identity: rescheduling (#749), recovery and re-fetch
// (#770) record work here. Re-fetch only needs the collector's store, not the
// workflow engine. Opening the writable store can fail
// (missing/incompatible/read-only). That must disable those actions, not
// prevent the read-only dashboard from starting.
let operations: OperationStore | undefined;
let attemptsUnreadable = false;
if (archive && env.data.STEELE_DASHBOARD_ORIGIN && e.STEELE_STATE_PATH) {
  try {
    operations = new OperationStore({ path: e.STEELE_STATE_PATH });
  } catch {
    operations = undefined;
    attemptsUnreadable = true;
  }
}
// Attempts are configured but unreadable: report run status as unavailable
// instead of presenting the stable run's result as current (#749).
const attemptSource: Pick<OperationStore, "articleAttempts"> | undefined =
  operations ??
  (attemptsUnreadable
    ? {
        articleAttempts: () => {
          throw new Error("attempt store unavailable");
        },
      }
    : undefined);
const trigger =
  archive && env.data.RESTATE_INGRESS_URL && env.data.STEELE_DASHBOARD_ORIGIN
    ? articleTrigger({
        archive,
        submitter: restateSubmitter(env.data.RESTATE_INGRESS_URL),
        researchRequestLimit: env.data.STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT,
        researchDeadlineMs: env.data.STEELE_DASHBOARD_RESEARCH_DEADLINE_MS,
        editorialPolicy: editorialPolicyFromEnv(process.env),
        // Read the same selected attempt the status views show (#749).
        runs: restateRuns(env.data.RESTATE_INGRESS_URL, 5_000, attemptSource),
        ...(operations ? { attempts: operations } : {}),
      })
    : undefined;
// Deliberate single-source re-fetch (#770): records the same typed request the
// reingest command uses; the running collector performs the fetch.
const refetch =
  archive && operations && env.data.STEELE_DASHBOARD_REFETCH === "1"
    ? {
        view: refetchView({ archive, operations }),
        ...refetchAction({ archive, operations }),
      }
    : undefined;
const recovery =
  trigger && archive && operations && env.data.RESTATE_INGRESS_URL
    ? articleRecovery({
        archive,
        researchRequestLimit: env.data.STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT,
        researchDeadlineMs: env.data.STEELE_DASHBOARD_RESEARCH_DEADLINE_MS,
        editorialPolicy: editorialPolicyFromEnv(process.env),
        submitter: restateSubmitter(env.data.RESTATE_INGRESS_URL),
        runs: restateRuns(env.data.RESTATE_INGRESS_URL, 5_000, attemptSource),
        identities: recoveryIdentities(operations),
      })
    : undefined;

const overview = statusView(
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
  // One console link on Overview (#816), only from a validated private base.
  (() => {
    const home = restateUiLinks(env.data.STEELE_RESTATE_UI_URL)?.home;
    return home ? { consoleUrl: home } : {};
  })(),
);
// Live article-stage activity for the console (#479).
const activityArticles = es ? indexArticles(es, e.STEELE_FULLTEXT_INDEX || undefined) : undefined;
const activityRuns = env.data.RESTATE_INGRESS_URL
  ? restateRuns(env.data.RESTATE_INGRESS_URL, 5_000, attemptSource)
  : undefined;
const activityView =
  activityArticles && activityRuns
    ? [
        {
          path: "/activity",
          title: "Activity",
          // Bounded polling so a newly started run appears without a manual reload.
          refreshSeconds: 15,
          render: async () =>
            renderActivity(
              await collectActivity({
                articles: activityArticles,
                runs: activityRuns,
                // Runs on any post, not only the newest articles (#479).
                ...(env.data.STEELE_RESTATE_ADMIN_URL
                  ? {
                      runIndex: restateRunIndex(
                        env.data.STEELE_RESTATE_ADMIN_URL,
                        activityArticles,
                      ),
                    }
                  : {}),
              }),
            ),
        },
      ]
    : [];
// Configuration projection (#544), editable only when explicitly enabled (#545).
const configEnabled =
  env.data.STEELE_CONFIG_EDIT === "1" &&
  env.data.STEELE_CONFIG_PATH !== undefined &&
  env.data.STEELE_CONFIG_VERSION_SALT !== undefined;
const configFile = env.data.STEELE_CONFIG_PATH;
const configSalt = env.data.STEELE_CONFIG_VERSION_SALT;
const configAction = configEnabled
  ? configEditAction({ path: configFile!, salt: configSalt! })
  : undefined;
const configView = [
  {
    path: "/config",
    title: "Configuration",
    async render() {
      const file = configFile ? await readSettingsFile(configFile) : {};
      const inspected = inspectSettings(resolveSettings(process.env, file));
      const page = await currentConfigPage(process.env, file);
      if (!configEnabled) return page;
      return `${page}${renderConfigForm(
        inspected,
        savedVersionOf(file, configSalt!),
        await listSettingsRevisions(configFile!),
      )}`;
    },
  },
];
const views = [
  overview,
  ...configView,
  ...activityView,
  ...(trigger ? [trigger.view] : []),
  ...(refetch ? [refetch.view] : []),
  ...(recovery ? [recovery.view] : []),
  ...articleViews({
    canTrigger: Boolean(trigger),
    canRecover: Boolean(recovery),
    canRefetch: Boolean(refetch),
    ...(trigger || refetch ? { actionOrigin: env.data.STEELE_DASHBOARD_ORIGIN } : {}),
    ...(es ? { articles: indexArticles(es, e.STEELE_FULLTEXT_INDEX || undefined) } : {}),
    ...(env.data.RESTATE_INGRESS_URL
      ? { runs: restateRuns(env.data.RESTATE_INGRESS_URL, 5_000, attemptSource) }
      : {}),
    ...(() => {
      // External workflow inspection (#561): only a validated private UI base.
      const links = restateUiLinks(env.data.STEELE_RESTATE_UI_URL);
      if (!links) return {};
      return {
        restate: {
          links,
          ...(env.data.STEELE_RESTATE_ADMIN_URL
            ? { lookup: restateInvocations(env.data.STEELE_RESTATE_ADMIN_URL) }
            : {}),
        },
      };
    })(),

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
    ...(archive ? { source: archivedSource(archive) } : {}),
    ...(content ? { themes: savedThemes(content) } : {}),
    ...(content ? { claims: savedClaims(content) } : {}),
    ...(content ? { assessments: savedAssessments(content) } : {}),
    ...(content ? { judgments: savedJudgments(content) } : {}),
  }),
  // Every saved draft with its exact verification and delivery status (#440).
  ...draftViews(
    content
      ? draftInventory(
          content,
          contentReceipts(content, {
            destinations: (e.STEELE_DASHBOARD_DESTINATIONS ?? "")
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean),
          }),
        )
      : undefined,
  ),
  // Saved theme proposals and the canonical catalogue, read-only (#493).
  ...themeViews(
    content ? savedThemes(content) : undefined,
    content ? savedResearch(content) : undefined,
  ),
  // Saved claim proposals with their quotations, read-only (#494).
  ...claimViews(content ? savedClaims(content, archive) : undefined),
  ...(content ? reviewViews(savedReviews(content)) : []),
  ...(content ? dossierViews(savedThemes(content), savedResearch(content)) : []),
  ...(content ? equivalenceViews(savedEquivalence(content)) : []),
  ...mappingViews(content),
  ...writerBrowseViews(content),
  // Search respects saved delete/restore markers (#478); reading them needs no write access.
  ...articlesBrowseViews(
    content ? draftInventory(content, undefined, new DraftTrashStore(content)) : undefined,
    content,
  ),
  ...themesBrowseViews(content ? savedThemes(content) : undefined, content),
  ...(content ? assessmentViews(savedAssessments(content)) : []),
  ...(content ? judgmentViews(savedJudgments(content)) : []),
  ...reviewsBrowseViews(
    content
      ? {
          assessments: savedAssessments(content),
          judgments: savedJudgments(content),
          reviews: savedReviews(content),
        }
      : undefined,
    content,
  ),
  ...(content ? researchBrowseViews(savedResearch(content)) : []),
  ...(content ? claimBrowseViews(content, savedClaims(content, archive)) : []),
  // Saved research reports and dossiers, read-only (#507).
  ...researchViews(content ? savedResearch(content) : undefined),
  // Preserve old bookmarks without a second navigation entry or placeholder.
  { ...overview, path: "/status", title: "Status", hidden: true },
];

// Run Corpus Refinement from the console (#831): the same workflow and
// submission contract as the CLI, fixture mode only.
const corpusAction = env.data.RESTATE_INGRESS_URL
  ? corpusRefinementAction({
      submitter: corpusRefinementSubmitter(env.data.RESTATE_INGRESS_URL),
      ...(() => {
        const links = restateUiLinks(env.data.STEELE_RESTATE_UI_URL);
        return links ? { links } : {};
      })(),
    })
  : undefined;
if (corpusAction && env.data.STEELE_DASHBOARD_ORIGIN) views.push(corpusAction.view);

// Recoverable trash for saved drafts (#478); markers live in the content repo.
// Writing markers mutates the content repository, so the console only offers
// this when the deployment explicitly enables it (#478).
const trashStore =
  content && env.data.STEELE_DASHBOARD_TRASH === "1" ? new DraftTrashStore(content) : undefined;
const trashAction = trashStore?.action();
// Actions need their exact origin for the same-origin check: without it, no
// action route is registered at all.
const actionOrigin = env.data.STEELE_DASHBOARD_ORIGIN;
const actions =
  (trigger || trashAction || refetch || corpusAction) && actionOrigin
    ? {
        origin: actionOrigin,
        routes: {
          ...(trigger ? { "/articles/run": trigger.submit } : {}),
          ...(recovery ? { "/articles/recover": recovery.submit } : {}),
          ...(trashAction ? { "/drafts/trash": trashAction.submit } : {}),
          ...(refetch ? { "/articles/refetch": refetch.submit } : {}),
          ...(configAction ? { "/config/save": configAction.submit } : {}),
          ...(corpusAction ? { "/corpus-refinement/run": corpusAction.submit } : {}),
        },
      }
    : undefined;
const server = createDashboardServer(views, actions);
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
  server.close(
    () =>
      void Promise.resolve(es?.close())
        .finally(() => {
          operations?.close();
        })
        .finally(() => process.exit(0)),
  );
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
