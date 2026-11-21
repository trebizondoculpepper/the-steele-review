/**
 * Captured-post indexing from Git (#252): keep the source full-text index in
 * step with committed revisions of the capture archive, replacing the
 * text-ready NATS trigger for indexing. NATS events are still published for
 * every other subscriber.
 *
 *   captured-index-worker [--once]
 *
 * Changes to the archive's branch refs (and the optional reference-transaction
 * wake hook, #251) are only a wake-up signal: every pass runs `catchUpIndex`
 * from the durable checkpoint, so dropped or coalesced notifications lose
 * nothing, and a periodic pass also runs without them. One pass at a time per
 * index, guarded by a lease in the state controller.
 *
 * Configuration (environment):
 *   STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY  capture archive (read only)
 *   STEELE_STATE_PATH                              state controller, for the reconciliation lease
 *   STEELE_CAPTURED_INDEX_CHECKPOINT               checkpoint file (the #249 bulk-load marker)
 *   STEELE_CAPTURED_INDEX_PUBLICATION?             limit to one publication (must match the checkpoint)
 *   ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY?
 *   STEELE_FULLTEXT_INDEX?                         logical index (alias); default steele-source-text-v1
 *   STEELE_CAPTURED_INDEX_INTERVAL_MS?             periodic pass; default 300000
 *
 * Output is sanitised JSON lines: counts and commits only.
 */
import { hostname } from "node:os";
import { z } from "zod";
import { fileCheckpoint } from "../collection/catchup-checkpoint.js";
import { catchUpIndex } from "../collection/index-catchup.js";
import { describeSetupError, elasticsearchConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { OperationStore } from "../controllers/operation-store.js";

const EnvSchema = z.object({
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_CAPTURED_INDEX_CHECKPOINT: z.string().min(1),
  STEELE_CAPTURED_INDEX_PUBLICATION: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
    .optional(),
  STEELE_FULLTEXT_INDEX: z.string().min(1).default("steele-source-text-v1"),
  STEELE_CAPTURED_INDEX_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(86_400_000)
    .default(300_000),
});

const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event: "captured-index", ...fields }));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a !== "--once")) {
    console.error("Usage: captured-index-worker [--once]");
    return 2;
  }
  const once = argv.includes("--once");
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`captured-index-worker: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  let esConn;
  try {
    esConn = elasticsearchConnection();
  } catch (error) {
    console.error(`captured-index-worker: ${describeSetupError(error)}`);
    return 2;
  }
  const es = new ElasticsearchController(esConn.url, esConn.apiKey);
  const artifacts = new GitArtifactStore({
    repoPath: c.STEELE_ARCHIVE_PATH,
    repository: c.STEELE_ARCHIVE_REPOSITORY,
  });
  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  const checkpoint = fileCheckpoint(c.STEELE_CAPTURED_INDEX_CHECKPOINT);
  const owner = `captured-index-worker@${hostname()}:${process.pid}`;
  const LEASE_MS = 10 * 60_000;
  const stop = new AbortController();

  const pass = async (reason: string): Promise<boolean> => {
    const claim = operations.claim(
      `captured-index:${c.STEELE_FULLTEXT_INDEX}`,
      owner,
      LEASE_MS,
      1_000_000,
    );
    if (claim.kind !== "claimed") {
      log({
        state: "skipped",
        reason,
        why: claim.kind === "busy" ? "another pass holds the lease" : claim.kind,
      });
      return claim.kind === "busy";
    }
    try {
      const report = await catchUpIndex({
        artifacts,
        index: es,
        indexName: c.STEELE_FULLTEXT_INDEX,
        checkpoint,
        ...(c.STEELE_CAPTURED_INDEX_PUBLICATION
          ? { publicationId: c.STEELE_CAPTURED_INDEX_PUBLICATION }
          : {}),
        signal: stop.signal,
      });
      const { failed, ...counts } = report;
      if (!report.unchanged || reason === "startup")
        log({
          state: report.ok ? "caught-up" : "retry-later",
          reason,
          ...counts,
          failed: failed.length,
          failures: failed.slice(0, 5).map((f) => f.reason),
        });
      return report.ok;
    } catch {
      log({ state: "retry-later", reason, category: "failed" });
      return false;
    } finally {
      try {
        operations.yieldClaim(claim.claim);
      } catch {
        // The lease expired and another pass took over.
      }
    }
  };

  try {
    if (once) return (await pass("once")) ? 0 : 1;
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
        } while (again && !stop.signal.aborted);
        running = false;
      })();
    };
    const notified = () => {
      clearTimeout(timer);
      timer = setTimeout(() => wake("notification"), 2_000);
    };
    const watcher = await artifacts.watchBranch(notified);
    log({
      state: "watching",
      notifications: watcher.active,
      intervalMs: c.STEELE_CAPTURED_INDEX_INTERVAL_MS,
    });
    wake("startup");
    const interval = setInterval(() => wake("periodic"), c.STEELE_CAPTURED_INDEX_INTERVAL_MS);
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    stop.abort();
    clearInterval(interval);
    clearTimeout(timer);
    watcher.close();
    while (running) await new Promise((r) => setTimeout(r, 100));
    log({ state: "stopped" });
    return 0;
  } finally {
    operations.close();
    await es.close();
  }
}

process.exitCode = await main();
