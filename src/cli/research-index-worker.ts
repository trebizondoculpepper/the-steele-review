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
 *   STEELE_STATE_PATH                    state controller, for the exclusive reconciliation lease
 *   ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY?
 *   STEELE_RESEARCH_COLLECTION_INDEX?               logical index (alias); default steele-research-collection-v1
 *   STEELE_RESEARCH_COLLECTION_INTERVAL_MS?   periodic reconciliation; default 300000
 *   STEELE_RESEARCH_INDEX_ROUTE?         route name this worker serves; default "default"
 *   STEELE_RESEARCH_REINDEX_CONSUMER?    durable consumer for reindex requests (#232); with
 *                                         NATS_URL, the worker also reconciles on request
 *
 * Output is sanitised JSON lines: counts and commits only.
 */
import { z } from "zod";
import { describeSetupError, elasticsearchConnection } from "../config/credentials.js";
import { hostname } from "node:os";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { OperationStore } from "../controllers/operation-store.js";
import { NatsController } from "../controllers/nats.js";
import { natsConnection } from "../config/credentials.js";
import { RESEARCH_STREAM } from "../events/research-completed-event.js";
import { RouteName } from "../events/research-reindex-event.js";
import { handleReindexRequest } from "../research/reindex-consumer.js";
import { ElasticsearchController, IndexingError } from "../controllers/elasticsearch.js";
import {
  RESEARCH_COLLECTION_INDEX_V1,
  reconcileResearchIndex,
} from "../research/research-index.js";

const EnvSchema = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_RESEARCH_INDEX_ROUTE: RouteName.default("default"),
  STEELE_RESEARCH_REINDEX_CONSUMER: z.string().min(1).optional(),
  STEELE_RESEARCH_STREAM: z.string().min(1).optional(),
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

  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  const owner = `research-index-worker@${hostname()}:${process.pid}`;
  const LEASE_MS = 10 * 60_000;
  const pass = async (reason: string): Promise<boolean> => {
    const result = await runPass(reason);
    return result !== false;
  };
  const runPass = async (reason: string): Promise<true | false | "busy"> => {
    // One reconciler at a time per index: a second worker or a --once run
    // alongside the daemon skips instead of interleaving checkpoint writes.
    const claim = operations.claim(
      `research-index:${c.STEELE_RESEARCH_COLLECTION_INDEX}`,
      owner,
      LEASE_MS,
      1_000_000,
    );
    if (claim.kind !== "claimed") {
      log({
        state: "skipped",
        reason,
        why: claim.kind === "busy" ? "another reconciler holds the lease" : claim.kind,
      });
      return claim.kind === "busy" ? "busy" : false;
    }
    try {
      const report = await reconcileResearchIndex({
        keepAlive: () => {
          operations.renew(claim.claim, LEASE_MS);
        },
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
    } finally {
      // Hand the lease back without consuming an attempt; a lost lease is fine.
      try {
        operations.yieldClaim(claim.claim);
      } catch {
        // Another reconciler took over after our lease expired.
      }
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
    const watcher = await artifacts.watchBranch(notified);
    log({
      state: "watching",
      notifications: watcher.active,
      intervalMs: c.STEELE_RESEARCH_COLLECTION_INTERVAL_MS,
    });
    wake("startup");
    const interval = setInterval(() => wake("periodic"), c.STEELE_RESEARCH_COLLECTION_INTERVAL_MS);

    // Reindex requests (#232): an operator or external scheduler asks for a
    // reconciliation of this worker's route through the broker.
    const stop = new AbortController();
    let consuming: Promise<void> | undefined;
    let nats: NatsController | undefined;
    if (c.STEELE_RESEARCH_REINDEX_CONSUMER && process.env.NATS_URL) {
      const conn = natsConnection();
      nats = new NatsController(conn.url, conn.token);
      await nats.connect("steele-research-index");
      const routes = new Set([c.STEELE_RESEARCH_INDEX_ROUTE]);
      consuming = nats
        .consume(
          c.STEELE_RESEARCH_STREAM ?? RESEARCH_STREAM,
          c.STEELE_RESEARCH_REINDEX_CONSUMER,
          async (message) => {
            const decision = await handleReindexRequest(message.data, routes, () =>
              runPass("request"),
            );
            log({ state: "request", ...decision });
            if (decision.action === "ack") await message.ack();
            else if (decision.action === "term") message.term();
            else message.nak(decision.delayMs);
          },
          stop.signal,
        )
        .catch(() => log({ state: "request-consumer-stopped" }));
      log({ state: "consuming-requests", route: c.STEELE_RESEARCH_INDEX_ROUTE });
    }
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    stop.abort();
    await consuming;
    await nats?.close();
    clearInterval(interval);
    clearTimeout(timer);
    watcher.close();
    log({ state: "stopped" });
    return 0;
  } finally {
    operations.close();
    await es.close();
  }
}

process.exitCode = await main();
