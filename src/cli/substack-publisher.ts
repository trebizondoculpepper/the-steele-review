/**
 * Live Substack publisher, draft-only (#385; design in doc/architecture/06).
 *
 *   substack-publisher
 *
 * Consumes approved articles from its own durable consumer on
 * `STEELE_PUBLICATION` and creates one editable Substack draft per approved
 * revision, read back and checked, with a receipt marked `simulated: false`.
 * It never publishes and never sends subscriber email.
 *
 * Live delivery is off unless STEELE_SUBSTACK_DELIVERY=live: otherwise the
 * service validates its configuration and that the session file is readable,
 * reports `ready`, and consumes nothing (approvals wait in its consumer). The
 * first live delivery is the one-draft proof (#384).
 *
 * Configuration (environment):
 *   NATS_URL, NATS_TOKEN?                            broker
 *   STEELE_CONTENT_PATH, STEELE_CONTENT_REPOSITORY   content repository (drafts, receipts)
 *   STEELE_STATE_PATH                                SQLite state (delivery claims)
 *   STEELE_SUBSTACK_ORIGIN                           https://<publication>.substack.com (private)
 *   STEELE_SUBSTACK_SESSION_FILE                     file holding the substack.sid value (private)
 *   STEELE_SUBSTACK_DELIVERY?                        "live" to deliver; anything else stays off
 *   STEELE_PUBLISHER_DESTINATION?                    default substack
 *   STEELE_PUBLISHER_CONSUMER?                       default steele-publisher-substack
 *   STEELE_PUBLICATION_STREAM?                       default STEELE_PUBLICATION
 *   STEELE_PUBLISHER_DELAY_MS?, STEELE_PUBLISHER_RETRY_DELAY_MS?
 *
 * Never logs the origin, the session or response bodies.
 */
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { describeSetupError, natsConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { NatsController } from "../controllers/nats.js";
import { OperationStore } from "../controllers/operation-store.js";
import { PUBLICATION_STREAM } from "../events/article-approved-event.js";
import { runPublisherService } from "../publishing/publisher-service.js";
import { SubstackClient } from "../publishing/substack/client.js";
import { SubstackDraftDestination } from "../publishing/substack/destination.js";

export const SUBSTACK_CONSUMER = "steele-publisher-substack";

const EnvSchema = z.object({
  STEELE_CONTENT_PATH: z.string().min(1),
  STEELE_CONTENT_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_SUBSTACK_ORIGIN: z.url({ protocol: /^https$/ }),
  STEELE_SUBSTACK_SESSION_FILE: z.string().min(1),
  STEELE_SUBSTACK_DELIVERY: z.string().optional(),
  STEELE_PUBLISHER_DESTINATION: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .default("substack"),
  STEELE_PUBLISHER_CONSUMER: z.string().min(1).default(SUBSTACK_CONSUMER),
  STEELE_PUBLICATION_STREAM: z.string().min(1).default(PUBLICATION_STREAM),
  STEELE_PUBLISHER_DELAY_MS: z.coerce.number().int().min(0).default(0),
  STEELE_PUBLISHER_RETRY_DELAY_MS: z.coerce.number().int().positive().default(30_000),
});

async function main(): Promise<number> {
  const env = EnvSchema.safeParse(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")),
  );
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`substack-publisher: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  const log = (fields: Record<string, unknown>) =>
    console.log(
      JSON.stringify({
        event: "substack-publisher",
        destination: c.STEELE_PUBLISHER_DESTINATION,
        ...fields,
      }),
    );
  // Re-read per request so a replaced session file takes effect without a restart.
  const session = async () => (await readFile(c.STEELE_SUBSTACK_SESSION_FILE, "utf8")).trim();
  try {
    if (!(await session())) throw new Error("empty");
  } catch {
    console.error("substack-publisher: session file is missing, unreadable or empty");
    return 2;
  }
  let client: SubstackClient;
  try {
    client = new SubstackClient({ origin: c.STEELE_SUBSTACK_ORIGIN, session });
  } catch {
    console.error("substack-publisher: STEELE_SUBSTACK_ORIGIN must be a bare https origin");
    return 2;
  }
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());

  if (c.STEELE_SUBSTACK_DELIVERY !== "live") {
    // Ready but not delivering: approvals stay queued for this consumer.
    log({ state: "ready", delivery: "off" });
    await sleep(2 ** 31 - 1, undefined, { signal: abort.signal }).catch(() => undefined);
    log({ state: "stopped" });
    return 0;
  }

  let natsConn;
  try {
    natsConn = natsConnection();
  } catch (error) {
    console.error(`substack-publisher: ${describeSetupError(error)}`);
    return 2;
  }
  const content = new GitArtifactStore({
    repoPath: c.STEELE_CONTENT_PATH,
    repository: c.STEELE_CONTENT_REPOSITORY,
  });
  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  const nats = new NatsController(natsConn.url, natsConn.token);
  try {
    await nats.connect(`steele-substack-publisher-${c.STEELE_PUBLISHER_DESTINATION}`);
    await runPublisherService({
      nats,
      stream: c.STEELE_PUBLICATION_STREAM,
      consumer: c.STEELE_PUBLISHER_CONSUMER,
      destination: new SubstackDraftDestination(client, { name: c.STEELE_PUBLISHER_DESTINATION }),
      content,
      operations,
      owner: `substack-publisher:${hostname()}:${process.pid}`,
      delayMs: c.STEELE_PUBLISHER_DELAY_MS,
      retryDelayMs: c.STEELE_PUBLISHER_RETRY_DELAY_MS,
      log,
      signal: abort.signal,
    });
    return 0;
  } catch {
    log({ state: "failed" });
    return 1;
  } finally {
    await nats.close();
    operations.close();
    log({ state: "stopped" });
  }
}

process.exitCode = await main();
