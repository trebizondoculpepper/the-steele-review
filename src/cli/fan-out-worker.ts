/**
 * Fan-out worker entry point: consume post-analysed completions from a
 * provisioned durable JetStream consumer and record one durable theme- and
 * claim-occurrence event per saved result (#179). Composition only; the logic
 * lives in analysis/fan-out.ts.
 *
 * Configuration (environment):
 *   NATS_URL, NATS_TOKEN?           broker
 *   STEELE_CONTENT_PATH             local path of the private content repository
 *   STEELE_CONTENT_REPOSITORY       logical repository name recorded in references
 *   STEELE_STATE_PATH               absolute path of the SQLite state file
 *   STEELE_ANALYSIS_STREAM          stream holding post-analysed events
 *   STEELE_ANALYSIS_CONSUMER        durable consumer name (provisioned separately)
 *   STEELE_FAN_OUT_RETRY_DELAY_MS?     redelivery delay after a retryable failure
 *   STEELE_FAN_OUT_DISPATCH_INTERVAL_MS?  pending-event drain interval (default 30000)
 *
 * Read-only with respect to source content: it never calls a model, retrieves
 * sources or starts research. Status lines are sanitised JSON. SIGTERM/SIGINT
 * stop consumption after the in-flight message and close the connection.
 */
import { hostname } from "node:os";
import { z } from "zod";
import { AnalysisFanOut } from "../analysis/fan-out.js";
import { describeSetupError, natsConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { NatsController } from "../controllers/nats.js";
import { OperationStore } from "../controllers/operation-store.js";

const EnvSchema = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_ANALYSIS_STREAM: z.string().min(1),
  STEELE_ANALYSIS_CONSUMER: z.string().min(1),
  STEELE_FAN_OUT_RETRY_DELAY_MS: z.coerce.number().int().positive().optional(),
  STEELE_FAN_OUT_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().optional(),
});

async function main(): Promise<number> {
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`fan-out-worker: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  let natsConn;
  try {
    natsConn = natsConnection();
  } catch (error) {
    console.error(`fan-out-worker: ${describeSetupError(error)}`);
    return 2;
  }

  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  const nats = new NatsController(natsConn.url, natsConn.token);
  const fanOut = new AnalysisFanOut({
    content: new GitArtifactStore({
      repoPath: c.STEELE_CONTENT_PATH,
      repository: c.STEELE_CONTENT_REPOSITORY,
    }),
    operations,
    publisher: nats,
    owner: `fan-out-worker:${hostname()}:${process.pid}`,
    retryDelayMs: c.STEELE_FAN_OUT_RETRY_DELAY_MS,
    onDecision: (decision) => console.log(JSON.stringify({ event: "fan-out", ...decision })),
  });
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  try {
    await nats.connect("steele-fan-out-worker");
    // Drain events stranded by an earlier crash or broker outage before
    // consuming: a parent acknowledged after recording may never be redelivered.
    const drained = await fanOut.dispatchPending();
    const intervalMs = c.STEELE_FAN_OUT_DISPATCH_INTERVAL_MS ?? 30_000;
    const timer = setInterval(() => {
      void fanOut.dispatchPending();
    }, intervalMs);
    timer.unref();
    console.log(JSON.stringify({ event: "fan-out", state: "consuming", drained }));
    try {
      await nats.consume(
        c.STEELE_ANALYSIS_STREAM,
        c.STEELE_ANALYSIS_CONSUMER,
        (m) => fanOut.handle(m).then(() => undefined),
        abort.signal,
      );
    } finally {
      clearInterval(timer);
    }
    return 0;
  } catch {
    console.error(JSON.stringify({ event: "fan-out", state: "failed" }));
    return 1;
  } finally {
    await nats.close();
    operations.close();
    console.log(JSON.stringify({ event: "fan-out", state: "stopped" }));
  }
}

process.exitCode = await main();
