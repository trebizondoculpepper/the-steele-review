/**
 * Incremental captured-post indexing (#250): apply archive changes since the
 * last successful checkpoint to the full-text index. Composition only; logic
 * lives in collection/index-catchup.ts.
 *
 * Usage:
 *   catch-up-index --checkpoint PATH [--publication ID]
 *
 * The checkpoint is the JSON marker `replay-index --commit SHA --checkpoint PATH`
 * writes after a bulk load (#249); without one, the first pass reconciles every
 * current record. The marker advances only after every change succeeded, and is
 * written atomically. Safe to repeat and to run on a schedule.
 *
 * Configuration (environment):
 *   ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY?
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY
 *   STEELE_FULLTEXT_INDEX?   logical index (alias); defaults to steele-source-text-v1
 *
 * Exit status: 0 when the index caught up (or nothing changed); 1 when any
 * change failed or the pass was interrupted; 2 for usage or configuration errors.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { catchUpIndex, type CatchUpCheckpointState } from "../collection/index-catchup.js";
import { CredentialError, elasticsearchConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";

const EnvSchema = z.object({
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  STEELE_FULLTEXT_INDEX: z.string().min(1).optional(),
});

export async function main(argv: string[]): Promise<number> {
  let checkpointPath: string;
  let publicationId: string | undefined;
  let env;
  let esConn;
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: { checkpoint: { type: "string" }, publication: { type: "string" } },
    });
    checkpointPath = z.string().min(1).parse(values.checkpoint);
    publicationId = values.publication
      ? z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
          .parse(values.publication)
      : undefined;
    env = EnvSchema.parse(process.env);
    esConn = elasticsearchConnection();
  } catch (error) {
    const message =
      error instanceof CredentialError
        ? error.message
        : error instanceof z.ZodError
          ? error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")
          : String(error);
    console.error(`catch-up-index: ${message}`);
    return 2;
  }
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  let es: ElasticsearchController;
  try {
    es = new ElasticsearchController(esConn.url, esConn.apiKey);
  } catch {
    // Never echo the configured URL: it may carry credentials.
    console.error("catch-up-index: ELASTICSEARCH_URL is not a valid URL");
    return 2;
  }
  const checkpoint = {
    async load(): Promise<CatchUpCheckpointState | undefined> {
      try {
        return JSON.parse(await readFile(checkpointPath, "utf8")) as CatchUpCheckpointState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async save(state: CatchUpCheckpointState) {
      const temporary = `${checkpointPath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
      await rename(temporary, checkpointPath);
    },
  };
  try {
    const report = await catchUpIndex({
      artifacts: new GitArtifactStore({
        repoPath: env.STEELE_ARCHIVE_PATH,
        repository: env.STEELE_ARCHIVE_REPOSITORY,
      }),
      index: es,
      ...(env.STEELE_FULLTEXT_INDEX ? { indexName: env.STEELE_FULLTEXT_INDEX } : {}),
      checkpoint,
      ...(publicationId ? { publicationId } : {}),
      signal: abort.signal,
    });
    console.log(JSON.stringify({ event: "catch-up-index", ...report }));
    return report.ok ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ event: "catch-up-index", ok: false, failureStage: "setup" }));
    return 1;
  } finally {
    await es.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
