/**
 * Dummy publisher consumer (#315).
 *
 *   dummy-publisher
 *
 * One placeholder destination: consumes approved articles from its own
 * durable consumer on `STEELE_PUBLICATION`, re-checks each approval against
 * the stored bytes and writes a receipt marked `simulated` under
 * `publications/<destination>/...` in the content repository
 * (publishing/approved-article.ts, #271). It makes no external call and holds
 * no credentials. Run one process per destination, each with its own consumer
 * and destination name, so their positions and receipts stay independent. A
 * redelivered approval reuses the existing receipt.
 *
 * Configuration (environment):
 *   NATS_URL, NATS_TOKEN?                 broker
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   content repository (drafts, receipts)
 *   STEELE_STATE_PATH                     SQLite state (delivery claims)
 *   STEELE_PUBLISHER_DESTINATION          destination name, e.g. dummy-a
 *   STEELE_PUBLISHER_CONSUMER             durable consumer (provisioned separately)
 *   STEELE_PUBLICATION_STREAM?            default STEELE_PUBLICATION
 *   STEELE_PUBLISHER_DELAY_MS?            delivery delay after approval (default 0)
 *   STEELE_PUBLISHER_RETRY_DELAY_MS?      redelivery delay after a failure (default 30000)
 *
 * Status lines are sanitised JSON. SIGTERM/SIGINT stop after the in-flight message.
 */
import { hostname } from "node:os";
import { z } from "zod";
import { describeSetupError, natsConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { NatsController } from "../controllers/nats.js";
import { OperationStore } from "../controllers/operation-store.js";
import { PUBLICATION_STREAM } from "../events/article-approved-event.js";
import { handleApprovedArticle, SimulatedDestination } from "../publishing/approved-article.js";

const EnvSchema = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_PUBLISHER_DESTINATION: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  STEELE_PUBLISHER_CONSUMER: z.string().min(1),
  STEELE_PUBLICATION_STREAM: z.string().min(1).default(PUBLICATION_STREAM),
  STEELE_PUBLISHER_DELAY_MS: z.coerce.number().int().min(0).default(0),
  STEELE_PUBLISHER_RETRY_DELAY_MS: z.coerce.number().int().positive().default(30_000),
});

async function main(): Promise<number> {
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`dummy-publisher: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  let natsConn;
  try {
    natsConn = natsConnection();
  } catch (error) {
    console.error(`dummy-publisher: ${describeSetupError(error)}`);
    return 2;
  }

  const content = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  const nats = new NatsController(natsConn.url, natsConn.token);
  const destination = new SimulatedDestination(c.STEELE_PUBLISHER_DESTINATION, "draft");
  const owner = `dummy-publisher:${c.STEELE_PUBLISHER_DESTINATION}:${hostname()}:${process.pid}`;
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  const log = (fields: Record<string, unknown>) =>
    console.log(
      JSON.stringify({
        event: "dummy-publisher",
        destination: c.STEELE_PUBLISHER_DESTINATION,
        ...fields,
      }),
    );
  try {
    await nats.connect(`steele-dummy-publisher-${c.STEELE_PUBLISHER_DESTINATION}`);
    log({ state: "consuming" });
    await nats.consume(
      c.STEELE_PUBLICATION_STREAM,
      c.STEELE_PUBLISHER_CONSUMER,
      async (m) => {
        const decision = await handleApprovedArticle({
          payload: new TextDecoder().decode(m.data),
          destination,
          schedule: { delayMs: c.STEELE_PUBLISHER_DELAY_MS },
          content,
          operations,
          owner,
          retryDelayMs: c.STEELE_PUBLISHER_RETRY_DELAY_MS,
        });
        if (decision.action === "ack") {
          log({ action: "ack", outcome: decision.outcome, receipt: decision.receipt.path });
          await m.ack();
        } else if (decision.action === "nak") {
          log({ action: "nak", reason: decision.reason });
          m.nak(decision.delayMs);
        } else {
          log({ action: "term", reason: decision.reason });
          m.term();
        }
      },
      abort.signal,
    );
    return 0;
  } catch {
    console.error(
      JSON.stringify({
        event: "dummy-publisher",
        destination: c.STEELE_PUBLISHER_DESTINATION,
        state: "failed",
      }),
    );
    return 1;
  } finally {
    await nats.close();
    operations.close();
    log({ state: "stopped" });
  }
}

process.exitCode = await main();
