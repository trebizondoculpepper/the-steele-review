/**
 * Archive-to-index replay: rebuild full-text index documents from committed
 * collection records. Composition only; logic lives in
 * collection/index-replay.ts.
 *
 * Usage:
 *   replay-index --publication ID --limit N [--post ID ...] [--from ISO] [--to ISO]
 *
 * Configuration (environment):
 *   ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY?
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY
 *   STEELE_FULLTEXT_INDEX?   logical index (alias); defaults to steele-source-text-v1
 *
 * Exit status: 0 when every selected record was indexed, unchanged or
 * incomplete; 1 when any failed; 2 for usage or configuration errors.
 */
import { CredentialError, elasticsearchConnection } from "../config/credentials.js";
import { parseArgs } from "node:util";
import { z } from "zod";
import { replayArchiveToIndex, ReplaySelectionSchema } from "../collection/index-replay.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";

const EnvSchema = z.object({
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  STEELE_FULLTEXT_INDEX: z.string().min(1).optional(),
});

export async function main(argv: string[]): Promise<number> {
  let selection;
  let env;
  let esConn;
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        publication: { type: "string" },
        post: { type: "string", multiple: true },
        from: { type: "string" },
        to: { type: "string" },
        limit: { type: "string" },
      },
    });
    selection = ReplaySelectionSchema.parse({
      publicationId: values.publication,
      ...(values.post?.length ? { postIds: values.post } : {}),
      ...(values.from ? { from: values.from } : {}),
      ...(values.to ? { to: values.to } : {}),
      limit: values.limit === undefined ? undefined : Number(values.limit),
    });
    env = EnvSchema.parse(process.env);
    esConn = elasticsearchConnection();
  } catch (error) {
    const message =
      error instanceof CredentialError
        ? error.message
        : error instanceof z.ZodError
          ? error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")
          : String(error);
    console.error(`replay-index: ${message}`);
    return 2;
  }

  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  const artifacts = new GitArtifactStore({
    repoPath: env.STEELE_ARCHIVE_PATH,
    repository: env.STEELE_ARCHIVE_REPOSITORY,
  });
  let es: ElasticsearchController;
  try {
    es = new ElasticsearchController(esConn.url, esConn.apiKey);
  } catch {
    // Never echo the configured URL: it may carry credentials.
    console.error("replay-index: ELASTICSEARCH_URL is not a valid URL");
    return 2;
  }
  try {
    const report = await replayArchiveToIndex({
      selection,
      artifacts,
      index: es,
      ...(env.STEELE_FULLTEXT_INDEX ? { indexName: env.STEELE_FULLTEXT_INDEX } : {}),
      signal: abort.signal,
    });
    console.log(JSON.stringify({ event: "replay-index", ...report }));
    return report.ok ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ event: "replay-index", ok: false, failureStage: "setup" }));
    return 1;
  } finally {
    await es.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
