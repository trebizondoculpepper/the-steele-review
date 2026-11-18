/**
 * One-shot backfill entry point. Composes the archive controller, discovery
 * event factory and NATS publisher; all logic lives in discovery/backfill.ts.
 *
 * Configuration: command-line bounds (see --help) plus NATS_URL, optional
 * NATS_TOKEN, optional STEELE_DISCOVERY_SUBJECT and STEELE_DISCOVERY_STREAM
 * from the environment. Output is a single sanitised JSON report; connection
 * details are never printed.
 */
import { NatsDiscoveryPublisher } from "../controllers/nats-discovery.js";
import { NatsController } from "../controllers/nats.js";
import { SubstackArchiveDiscovery } from "../controllers/substack/archive.js";
import {
  BACKFILL_USAGE,
  BackfillUsageError,
  parseBackfillArgs,
  runBackfill,
} from "../discovery/backfill.js";
import { createDiscoveryEvent } from "../events/discovery-event.js";

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(BACKFILL_USAGE);
    return 0;
  }
  let options;
  try {
    options = parseBackfillArgs(argv);
  } catch (error) {
    if (error instanceof BackfillUsageError) {
      console.error(`backfill: ${error.message}\n\n${BACKFILL_USAGE}`);
      return 2;
    }
    throw error;
  }
  const natsUrl = process.env.NATS_URL;
  if (!natsUrl) {
    console.error("backfill: NATS_URL is required");
    return 2;
  }

  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const nats = new NatsController(natsUrl, process.env.NATS_TOKEN);
  try {
    await nats.connect("steele-backfill");
    const report = await runBackfill({
      options,
      source: new SubstackArchiveDiscovery({
        publicationUrl: options.publicationUrl,
        publicationId: options.publicationId,
      }),
      createEvent: (item, eventOptions) => createDiscoveryEvent(item, eventOptions),
      publisher: new NatsDiscoveryPublisher(nats, {
        subject: process.env.STEELE_DISCOVERY_SUBJECT || undefined,
        expectStream: process.env.STEELE_DISCOVERY_STREAM || undefined,
      }),
      signal: abort.signal,
    });
    console.log(JSON.stringify({ event: "backfill", ...report }));
    return report.ok ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ event: "backfill", ok: false, failureStage: "setup" }));
    return 1;
  } finally {
    await nats.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
