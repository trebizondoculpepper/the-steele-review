/**
 * Live discovery entry point: poll one public Substack feed immediately and
 * then periodically, publishing a `live` discovery event per entry.
 * Composes the RSS controller (#7), single run (#9), periodic runner (#10)
 * and NATS publisher (#4); no business logic lives here.
 *
 * Configuration (environment):
 *   NATS_URL                  required
 *   NATS_TOKEN                optional
 *   STEELE_FEED_URL           required, public HTTPS feed
 *   STEELE_PUBLICATION_ID     required, normalised publication ID
 *   STEELE_POLL_INTERVAL_MS   optional, default 300000
 *   STEELE_MAX_BACKOFF_MS     optional
 *   STEELE_DISCOVERY_SUBJECT  optional
 *   STEELE_DISCOVERY_STREAM   optional, require this stream to capture events
 *   STEELE_DISCOVERY_STATUS_PATH  optional, write the last poll status for the dashboard
 *
 * Status lines are sanitised JSON; connection details are never printed.
 * The existing connectivity health service (main.ts) is unchanged.
 */
import { describeSetupError, natsConnection } from "../config/credentials.js";
import { z } from "zod";
import { NatsDiscoveryPublisher } from "../controllers/nats-discovery.js";
import { NatsController } from "../controllers/nats.js";
import { SubstackRssDiscovery } from "../controllers/substack/rss.js";
import { PeriodicDiscoveryRunner } from "../discovery/periodic.js";
import { writeDiscoveryStatus } from "../discovery/status.js";
import { runDiscovery } from "../discovery/run.js";
import { createDiscoveryEvent } from "../events/discovery-event.js";

const EnvSchema = z.object({
  STEELE_FEED_URL: z.url({ protocol: /^https$/ }),
  STEELE_PUBLICATION_ID: z.string().min(1),
  STEELE_POLL_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  STEELE_MAX_BACKOFF_MS: z.coerce.number().int().positive().optional(),
  STEELE_DISCOVERY_SUBJECT: z.string().min(1).optional(),
  STEELE_DISCOVERY_STREAM: z.string().min(1).optional(),
  STEELE_DISCOVERY_STATUS_PATH: z.string().min(1).optional(),
});

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
  let completedRuns = 0;
  let lastPollAt: string | undefined;
  const runner = new PeriodicDiscoveryRunner({
    run: (signal) =>
      runDiscovery({
        source: feed.getRecentItems(signal),
        reason: "live",
        createEvent: (item, options) => createDiscoveryEvent(item, options),
        publisher,
        signal,
      }),
    intervalMs: config.STEELE_POLL_INTERVAL_MS,
    maxBackoffMs: config.STEELE_MAX_BACKOFF_MS,
    onStatus: (status) => {
      if (status.state === "waiting" || status.state === "stopped") {
        console.log(JSON.stringify({ event: "discovery", ...status }));
      }
      // A lifecycle update is not a poll: only a completed run advances the
      // last-poll time, so starting or stopping cannot make a stale feed look
      // current.
      const at = new Date().toISOString();
      if (status.runs > completedRuns) {
        completedRuns = status.runs;
        lastPollAt = at;
      }
      // Best effort: a status file that cannot be written must not stop polling.
      if (config.STEELE_DISCOVERY_STATUS_PATH) {
        void writeDiscoveryStatus(config.STEELE_DISCOVERY_STATUS_PATH, {
          ...status,
          at,
          ...(lastPollAt ? { lastPollAt } : {}),
        }).catch(() => undefined);
      }
    },
  });

  const stop = () => {
    void runner.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await runner.start();
  await nats.close();
  return 0;
}

process.exitCode = await main();
