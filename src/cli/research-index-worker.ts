/**
 * Research collection indexing worker (#225): keep the research full-text
 * index in step with committed revisions of the private content repository.
 *
 *   research-index-worker [--once]
 *
 * Filesystem change notifications on the repository's branch refs are only a
 * wake-up signal. Every pass reads committed revisions through the artifact
 * store and reconciles from the durable checkpoint, so dropped or coalesced
 * notifications lose nothing; a periodic pass also runs without them.
 *
 * Configuration (environment):
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   private content repository (read only)
 *   ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY?
 *   STEELE_RESEARCH_COLLECTION_INDEX?               logical index (alias); default steele-research-collection-v1
 *   STEELE_RESEARCH_COLLECTION_INTERVAL_MS?   periodic reconciliation; default 300000
 *
 * Output is sanitised JSON lines: counts and commits only.
 */
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { describeSetupError, elasticsearchConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { ElasticsearchController, IndexingError } from "../controllers/elasticsearch.js";
import {
  RESEARCH_COLLECTION_INDEX_V1,
  reconcileResearchIndex,
} from "../research/research-index.js";

const EnvSchema = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_RESEARCH_COLLECTION_INDEX: z.string().min(1).default(RESEARCH_COLLECTION_INDEX_V1),
  STEELE_RESEARCH_COLLECTION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(86_400_000)
    .default(300_000),
});

const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event: "research-index", ...fields }));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a !== "--once")) {
    console.error("Usage: research-index-worker [--once]");
    return 2;
  }
  const once = argv.includes("--once");
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`research-index-worker: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  let esConn;
  try {
    esConn = elasticsearchConnection();
  } catch (error) {
    console.error(`research-index-worker: ${describeSetupError(error)}`);
    return 2;
  }
  const es = new ElasticsearchController(esConn.url, esConn.apiKey);
  const artifacts = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });

  const pass = async (reason: string): Promise<boolean> => {
    try {
      const report = await reconcileResearchIndex({
        artifacts,
        es,
        index: c.STEELE_RESEARCH_COLLECTION_INDEX,
      });
      if (!report.unchanged || reason === "startup")
        log({ state: "reconciled", reason, ...report });
      return true;
    } catch (error) {
      const category = error instanceof IndexingError ? error.category : "failed";
      log({ state: "retry-later", reason, category });
      return false;
    }
  };

  try {
    if (once) return (await pass("startup")) ? 0 : 1;

    let running = false;
    let again = false;
    let timer: NodeJS.Timeout | undefined;
    const wake = (reason: string) => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      void (async () => {
        do {
          again = false;
          await pass(reason);
        } while (again);
        running = false;
      })();
    };
    // Debounce bursts of ref updates (one commit can touch several files).
    const notified = () => {
      clearTimeout(timer);
      timer = setTimeout(() => wake("notification"), 2_000);
    };
    const watchers: FSWatcher[] = [];
    for (const dir of [
      join(c.STEELE_CONTENT_PATH, "refs", "heads"),
      join(c.STEELE_CONTENT_PATH, ".git", "refs", "heads"),
    ]) {
      try {
        watchers.push(watch(dir, notified));
      } catch {
        // Not this layout; the periodic pass still reconciles.
      }
    }
    try {
      watchers.push(
        watch(c.STEELE_CONTENT_PATH, (_event, name) => name === "packed-refs" && notified()),
      );
    } catch {
      // Periodic reconciliation covers it.
    }
    log({
      state: "watching",
      notifications: watchers.length > 0,
      intervalMs: c.STEELE_RESEARCH_COLLECTION_INTERVAL_MS,
    });
    wake("startup");
    const interval = setInterval(() => wake("periodic"), c.STEELE_RESEARCH_COLLECTION_INTERVAL_MS);
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    clearInterval(interval);
    clearTimeout(timer);
    for (const w of watchers) w.close();
    log({ state: "stopped" });
    return 0;
  } finally {
    await es.close();
  }
}

process.exitCode = await main();
