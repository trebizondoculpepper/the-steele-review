/**
 * Approval outbox dispatcher (#314).
 *
 *   approval-dispatcher [--once]
 *
 * Publishes durable approved-article events from the state controller's outbox
 * to `steele.v1.article.approved` on `STEELE_PUBLICATION`, using the logic in
 * publishing/approval-dispatch.ts (#271). It must use the same state file as
 * the article worker, because the workflow's approve stage writes the outbox
 * there. Each event's ID is the JetStream message ID, so a repeated dispatch
 * is deduplicated by the broker; a failed publish stays pending and is retried.
 *
 * Configuration (environment):
 *   NATS_URL, NATS_TOKEN?                       broker
 *   STEELE_STATE_PATH                           the article worker's SQLite state file
 *   STEELE_APPROVAL_DISPATCH_INTERVAL_MS?       drain interval (default 15000)
 *   STEELE_APPROVAL_RETRY_DELAY_MS?             delay before a failed publish is retried (default 60000)
 *
 * `--once` drains what is due, prints the counts and exits (used by checks).
 * Never calls a model or reads content. Status lines are sanitised JSON.
 * SIGTERM/SIGINT stop after the in-flight pass.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { describeSetupError, natsConnection } from "../config/credentials.js";
import { NatsController } from "../controllers/nats.js";
import { OperationStore } from "../controllers/operation-store.js";
import { dispatchApprovedArticles } from "../publishing/approval-dispatch.js";

const EnvSchema = z.object({
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_APPROVAL_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  STEELE_APPROVAL_RETRY_DELAY_MS: z.coerce.number().int().positive().default(60_000),
});

async function main(argv: string[]): Promise<number> {
  const once = argv.includes("--once");
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`approval-dispatcher: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  let natsConn;
  try {
    natsConn = natsConnection();
  } catch (error) {
    console.error(`approval-dispatcher: ${describeSetupError(error)}`);
    return 2;
  }

  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  const nats = new NatsController(natsConn.url, natsConn.token);
  const pass = () =>
    dispatchApprovedArticles({
      operations,
      publisher: nats,
      retryDelayMs: c.STEELE_APPROVAL_RETRY_DELAY_MS,
    });
  try {
    await nats.connect("steele-approval-dispatcher");
    if (once) {
      console.log(JSON.stringify({ event: "approval-dispatch", ...(await pass()) }));
      return 0;
    }
    const abort = new AbortController();
    process.once("SIGTERM", () => abort.abort());
    process.once("SIGINT", () => abort.abort());
    console.log(JSON.stringify({ event: "approval-dispatch", state: "running" }));
    // One pass at a time: a slow broker must not stack overlapping passes.
    while (!abort.signal.aborted) {
      const result = await pass().catch(() => undefined);
      if (!result)
        console.error(JSON.stringify({ event: "approval-dispatch", state: "pass-failed" }));
      else if (result.sent || result.retrying)
        console.log(JSON.stringify({ event: "approval-dispatch", ...result }));
      // An abortable timer: no listener outlives its interval.
      await sleep(c.STEELE_APPROVAL_DISPATCH_INTERVAL_MS, undefined, {
        signal: abort.signal,
      }).catch(() => undefined);
    }
    return 0;
  } catch {
    console.error(JSON.stringify({ event: "approval-dispatch", state: "failed" }));
    return 1;
  } finally {
    await nats.close();
    operations.close();
    console.log(JSON.stringify({ event: "approval-dispatch", state: "stopped" }));
  }
}

process.exitCode = await main(process.argv.slice(2));
