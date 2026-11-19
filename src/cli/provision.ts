/**
 * Explicit, opt-in provisioning of the capture pipeline's own resources:
 * the discovery and text-ready JetStream streams, the collector's and
 * indexer's durable consumers, and the full-text index alias. Never run
 * implicitly. Existing resources are left unchanged; a conflicting stream or
 * consumer is refused, never modified, and nothing unrelated is touched.
 *
 * Configuration (environment):
 *   NATS_URL, NATS_TOKEN?
 *   ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY?
 *   STEELE_DISCOVERY_STREAM?   default STEELE_DISCOVERY
 *   STEELE_CONTENT_STREAM?     default STEELE_CONTENT
 *   STEELE_COLLECT_CONSUMER?   default steele-collector
 *   STEELE_INDEX_CONSUMER?     default steele-indexer
 *   STEELE_FULLTEXT_INDEX?     default steele-source-text-v1
 *
 * Output is one JSON line naming each resource and whether it was created.
 */
import { z } from "zod";
import { FULLTEXT_INDEX_MAPPING, FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { DEFAULT_DISCOVERY_SUBJECT } from "../controllers/nats-discovery.js";
import {
  provisionDiscoveryStream,
  provisionDurableConsumer,
} from "../controllers/nats-provision.js";
import { NatsController } from "../controllers/nats.js";
import { TEXT_READY_SUBJECT } from "../events/text-ready-event.js";

const EnvSchema = z.object({
  NATS_URL: z.string().min(1),
  NATS_TOKEN: z.string().optional(),
  ELASTICSEARCH_URL: z.string().min(1),
  ELASTICSEARCH_API_KEY: z.string().optional(),
  STEELE_DISCOVERY_STREAM: z.string().min(1).default("STEELE_DISCOVERY"),
  STEELE_CONTENT_STREAM: z.string().min(1).default("STEELE_CONTENT"),
  STEELE_COLLECT_CONSUMER: z.string().min(1).default("steele-collector"),
  STEELE_INDEX_CONSUMER: z.string().min(1).default("steele-indexer"),
  STEELE_FULLTEXT_INDEX: z.string().min(1).default(FULLTEXT_INDEX_V1),
});

async function main(): Promise<number> {
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`provision: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  const nats = new NatsController(c.NATS_URL, c.NATS_TOKEN || undefined);
  let es: ElasticsearchController | undefined;
  const report: Record<string, string> = {};
  try {
    es = new ElasticsearchController(c.ELASTICSEARCH_URL, c.ELASTICSEARCH_API_KEY || undefined);
    await nats.connect("steele-provision");
    report.discoveryStream = await provisionDiscoveryStream(nats, {
      name: c.STEELE_DISCOVERY_STREAM,
      subjects: [DEFAULT_DISCOVERY_SUBJECT],
    });
    report.contentStream = await provisionDiscoveryStream(nats, {
      name: c.STEELE_CONTENT_STREAM,
      subjects: [TEXT_READY_SUBJECT],
    });
    report.collectConsumer = await provisionDurableConsumer(nats, {
      stream: c.STEELE_DISCOVERY_STREAM,
      name: c.STEELE_COLLECT_CONSUMER,
      filterSubject: DEFAULT_DISCOVERY_SUBJECT,
    });
    report.indexConsumer = await provisionDurableConsumer(nats, {
      stream: c.STEELE_CONTENT_STREAM,
      name: c.STEELE_INDEX_CONSUMER,
      filterSubject: TEXT_READY_SUBJECT,
    });
    report.fulltextIndex = await es.provisionIndex(c.STEELE_FULLTEXT_INDEX, FULLTEXT_INDEX_MAPPING);
    console.log(JSON.stringify({ event: "provision", ok: true, ...report }));
    return 0;
  } catch (error) {
    // Name the failing step, never connection details.
    console.error(
      JSON.stringify({
        event: "provision",
        ok: false,
        completed: report,
        error: error instanceof Error ? error.name : "error",
      }),
    );
    return 1;
  } finally {
    await nats.close();
    await es?.close();
  }
}

process.exitCode = await main();
