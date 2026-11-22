import { editorialContinuationWorkflow } from "../workflow/editorial-continuation.js";
import { editorialPolicyFromEnv } from "../workflow/editorial-contract.js";
import { restateParentCompletion } from "../controllers/editorial-continuation-ingress.js";
import { writerMechanicalPolicy } from "../drafting/mechanical-policy.js";
/**
 * Restate worker for unattended article runs (#243).
 *
 *   article-worker
 *
 * Serves the `ArticleRun` workflow and the `Research` service over HTTP for a
 * Restate server to call. Register it once with the server (see
 * doc/operations/article-pipeline.md). Stages reuse the delivered modules.
 *
 * Configuration (environment):
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY   captured sources (read only)
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   private content repository
 *   STEELE_STATE_PATH                                state controller (research job leases)
 *   OPENROUTER_API_KEY[_FILE], STEELE_MODEL          default model for model-backed stages
 *   STEELE_MODEL_THEMES?, STEELE_MODEL_CLAIMS?, STEELE_MODEL_WRITER?, STEELE_MODEL_SUPPORT?, STEELE_MODEL_VERIFIER?
 *                                                    per-stage overrides
 *   STEELE_RESEARCH_MODEL?, STEELE_RESEARCH_TIMEOUT_MS?, STEELE_RESEARCH_MAX_OUTPUT_TOKENS?
 *   STEELE_MONITORED_HOSTS?                          comma-separated claimant hosts
 *   ELASTICSEARCH_URL?, ELASTICSEARCH_API_KEY[_FILE]?  claim-occurrence index; enables same-speaker
 *                                                    history in the essay (#370)
 *   STEELE_MODEL_HISTORY?                            model for history matching and comparison
 *   STEELE_ARTICLE_WORKER_PORT?                      default 9080
 */
import { SourceMetadataError, sourceMetadataFromEnv } from "../content/source-metadata.js";
import { hostname } from "node:os";
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { elasticsearchConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { OperationStore } from "../controllers/operation-store.js";
import { writerModel } from "../config/writer-model.js";
import {
  CLAIM_EXTRACTION_MAX_OUTPUT_TOKENS,
  openRouterFromEnv,
} from "../controllers/openrouter.js";
import { PublicPageFetcher } from "../controllers/research-web.js";
import { LexicalShortlister } from "../research/librarian.js";
import { sonarFromEnv } from "../research/sonar.js";
import { ModelSupportJudge } from "../research/support-judge.js";
import { articleRunWorkflow, researchService } from "../workflow/article-run.js";
import { articleStages } from "../workflow/stages.js";

const Env = z.object({
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_MONITORED_HOSTS: z.string().optional(),
  STEELE_ARTICLE_WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(9080),
});

function main(): number {
  const env = Env.safeParse(process.env);
  if (!env.success) {
    console.error(
      `article-worker: invalid or missing configuration: ${[...new Set(env.error.issues.map((i) => i.path.join(".")))].join(", ")}`,
    );
    return 2;
  }
  const c = env.data;
  // Per-stage model choices, defaulting to STEELE_MODEL.
  const model = (override: string) =>
    openRouterFromEnv(
      {
        env: {
          ...process.env,
          ...(process.env[override] ? { STEELE_MODEL: process.env[override] } : {}),
        },
      },
      override === "STEELE_MODEL_CLAIMS"
        ? { maxOutputTokens: CLAIM_EXTRACTION_MAX_OUTPUT_TOKENS }
        : {},
    );
  // Same-speaker history needs the occurrence index; without it the essay
  // simply has no historical section.
  let history;
  if (process.env.ELASTICSEARCH_URL) {
    try {
      const es = elasticsearchConnection();
      history = {
        search: new ElasticsearchController(es.url, es.apiKey),
        provider: model("STEELE_MODEL_HISTORY"),
      };
    } catch {
      console.error("article-worker: Elasticsearch or history model is not configured");
      return 2;
    }
  }
  let stages;
  let sonar;
  let writer;
  let continuation;
  try {
    sonar = sonarFromEnv();
    writer = openRouterFromEnv({ env: { ...process.env, STEELE_MODEL: writerModel(process.env) } });
    const sourceMetadata = sourceMetadataFromEnv(process.env);
    const archive = new GitArtifactStore({
      repoPath: c.STEELE_ARCHIVE_PATH,
      repository: c.STEELE_ARCHIVE_REPOSITORY,
    });
    const content = new GitArtifactStore({
      repoPath: c.STEELE_CONTENT_PATH,
      repository: c.STEELE_CONTENT_REPOSITORY,
    });
    const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
    stages = articleStages({
      ...(sourceMetadata ? { sourceMetadata } : {}),
      mechanicalPolicy: writerMechanicalPolicy(process.env),
      archive,
      content,
      operations,
      models: {
        themes: model("STEELE_MODEL_THEMES"),
        claims: model("STEELE_MODEL_CLAIMS"),
        writer,
        verifier: model("STEELE_MODEL_VERIFIER"),
      },
      shortlister: new LexicalShortlister(),
      research: {
        sonar,
        fetcher: new PublicPageFetcher(),
        judge: new ModelSupportJudge(model("STEELE_MODEL_SUPPORT")),
        // Staged stages are always registered; submitters choose the contract per run (#593).
        staged: true,
        ...(c.STEELE_MONITORED_HOSTS
          ? {
              monitoredHosts: c.STEELE_MONITORED_HOSTS.split(",")
                .map((h) => h.trim())
                .filter(Boolean),
            }
          : {}),
      },
      ...(history ? { history } : {}),
      owner: `article-worker@${hostname()}:${process.pid}`,
    });
    continuation = editorialContinuationWorkflow({
      content,
      archive,
      operations,
      sourceMetadata,
      stages: stages.editorial!,
      configuredPolicy: editorialPolicyFromEnv(process.env),
      parentCompletion: restateParentCompletion(process.env.RESTATE_INGRESS_URL),
    });
  } catch (error) {
    if (error instanceof SourceMetadataError) {
      console.error(`article-worker: source metadata ${error.code}`);
      return 2;
    }
    console.error("article-worker: model or research provider is not configured");
    return 2;
  }
  restate.serve({
    services: [articleRunWorkflow(stages), researchService(stages), continuation],
    port: c.STEELE_ARTICLE_WORKER_PORT,
  });
  console.log(
    JSON.stringify({
      event: "article-worker",
      state: "serving",
      port: c.STEELE_ARTICLE_WORKER_PORT,
      // Effective settings, never credentials (#317).
      writerModel: writer.modelVersion,
      research: sonar.settings,
    }),
  );
  return 0;
}

process.exitCode = main();
