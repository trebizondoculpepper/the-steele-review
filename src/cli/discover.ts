/**
 * Live discovery entry point (#823): serve the per-source DiscoveryPoll
 * Restate object and start its schedule. Each poll, scheduled or on demand,
 * is a durable Restate invocation; polls of one source never overlap, and
 * restarting this process replaces the schedule rather than adding one.
 * Composes the RSS controller (#7), the NATS publisher (#4) and the poll
 * object; no business logic lives here.
 *
 * Configuration (environment):
 *   NATS_URL                  required
 *   NATS_TOKEN                optional
 *   STEELE_FEED_URL           required, public HTTPS feed
 *   STEELE_PUBLICATION_ID     required, normalised publication ID; the poll key
 *   RESTATE_INGRESS_URL       required, to start the schedule
 *   STEELE_DISCOVERY_PORT     optional, Restate endpoint port, default 9081
 *   STEELE_POLL_INTERVAL_MS   optional, default 300000
 *   STEELE_MAX_BACKOFF_MS     optional
 *   STEELE_DISCOVERY_SUBJECT  optional
 *   STEELE_DISCOVERY_STREAM   optional, require this stream to capture events
 *   STEELE_DISCOVERY_STATUS_PATH  optional, write the last poll status for the dashboard
 *
 * The endpoint must be registered with Restate (deploy/restate/register.sh)
 * before the schedule can start; until then, starting is retried.
 * Status lines are sanitised JSON; connection details are never printed.
 */
import { describeSetupError, natsConnection } from "../config/credentials.js";
import { z } from "zod";
import { NatsDiscoveryPublisher } from "../controllers/nats-discovery.js";
import { NatsController } from "../controllers/nats.js";
import { SubstackRssDiscovery } from "../controllers/substack/rss.js";
import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { DEFAULT_INTERVAL_MS } from "../discovery/periodic.js";
import { discoveryPollObject, type DiscoveryPollObject } from "../discovery/restate-poll.js";
import { writeDiscoveryStatus } from "../discovery/status.js";

const EnvSchema = z.object({
  STEELE_FEED_URL: z.url({ protocol: /^https$/ }),
  STEELE_PUBLICATION_ID: z.string().min(1),
  STEELE_POLL_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  STEELE_MAX_BACKOFF_MS: z.coerce.number().int().positive().optional(),
  STEELE_DISCOVERY_SUBJECT: z.string().min(1).optional(),
  STEELE_DISCOVERY_STREAM: z.string().min(1).optional(),
  STEELE_DISCOVERY_STATUS_PATH: z.string().min(1).optional(),
  RESTATE_INGRESS_URL: z.url({ protocol: /^https?$/ }),
  STEELE_DISCOVERY_PORT: z.coerce.number().int().min(1).max(65535).default(9081),
});

/** Start the schedule, retrying until the endpoint is registered with Restate. */
async function startSchedule(ingressUrl: string, key: string, signal: AbortSignal): Promise<void> {
  const ingress = clients.connect({ url: ingressUrl });
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      await ingress
        .objectClient<DiscoveryPollObject>({ name: "DiscoveryPoll" }, key)
        .start(clients.rpc.opts({ signal: AbortSignal.timeout(15_000) }));
      console.log(JSON.stringify({ event: "discovery", state: "scheduled" }));
      return;
    } catch {
      console.error(JSON.stringify({ event: "discovery", state: "waiting-for-restate", attempt }));
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 5_000 * 2 ** attempt)));
    }
  }
}

async function main(): Promise<number> {
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`discover: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const config = env.data;
  let natsConn;
  try {
    natsConn = natsConnection();
  } catch (error) {
    console.error(`discover: ${describeSetupError(error)}`);
    return 2;
  }

  const nats = new NatsController(natsConn.url, natsConn.token);
  try {
    await nats.connect("steele-discovery");
  } catch {
    console.error(JSON.stringify({ event: "discovery", state: "failed", stage: "connect" }));
    return 1;
  }
  const feed = new SubstackRssDiscovery({
    feedUrl: config.STEELE_FEED_URL,
    publicationId: config.STEELE_PUBLICATION_ID,
  });
  const publisher = new NatsDiscoveryPublisher(nats, {
    subject: config.STEELE_DISCOVERY_SUBJECT,
    expectStream: config.STEELE_DISCOVERY_STREAM,
  });
  const intervalMs = config.STEELE_POLL_INTERVAL_MS ?? DEFAULT_INTERVAL_MS;
  const statusPath = config.STEELE_DISCOVERY_STATUS_PATH;
  const poll = discoveryPollObject({
    sources: [config.STEELE_PUBLICATION_ID],
    fetchItems: () => feed.getRecentItems(),
    publisher,
    intervalMs,
    maxBackoffMs: config.STEELE_MAX_BACKOFF_MS ?? Math.max(intervalMs, 60 * 60 * 1000),
    ...(statusPath
      ? {
          writeStatus: (_key, status) =>
            writeDiscoveryStatus(statusPath, { ...status, at: new Date().toISOString() }),
        }
      : {}),
  });
  await restate.serve({ services: [poll], port: config.STEELE_DISCOVERY_PORT });

  const stopping = new AbortController();
  const stop = () => {
    stopping.abort();
    void nats.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await startSchedule(config.RESTATE_INGRESS_URL, config.STEELE_PUBLICATION_ID, stopping.signal);
  return 0;
}

process.exitCode = await main();
