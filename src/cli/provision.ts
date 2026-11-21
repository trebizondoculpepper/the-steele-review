/**
 * Explicit, opt-in provisioning of the capture pipeline's own resources:
 * the discovery and text-ready JetStream streams, the collector's and
 * indexer's durable consumers, and the full-text index alias. Never run
 * implicitly. A registry stream may gain a new subject (additive only, keeping
 * retained messages); any other conflicting stream or consumer is refused,
 * never modified, and nothing unrelated is touched.
 *
 * Configuration (environment):
 *   NATS_URL, NATS_TOKEN?
 *   ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY?
 *   STEELE_DISCOVERY_STREAM?   default STEELE_DISCOVERY
 *   STEELE_CONTENT_STREAM?     default STEELE_CONTENT
 *   STEELE_ANALYSIS_STREAM?    default STEELE_ANALYSIS (post-analysed events)
 *   STEELE_RESEARCH_STREAM?    default STEELE_RESEARCH (research completions)
 *   (stream definitions live in src/events/registry.ts)
 *   STEELE_COLLECT_CONSUMER?   default steele-collector
 *   STEELE_INDEX_CONSUMER?     default steele-indexer
 *   STEELE_RESEARCH_REINDEX_CONSUMER? default steele-research-indexer (#232)
 *   STEELE_PUBLISHER_CONSUMERS? comma-separated durable consumers on the
 *                              publication stream, one per destination (#315);
 *                              default none
 *   STEELE_PUBLISHER_NEW_ONLY_CONSUMERS? the same, but starting from approvals
 *                              published after provisioning: for live
 *                              destinations such as Substack (#385), so an
 *                              existing backlog never becomes real drafts
 *   STEELE_FULLTEXT_INDEX?     default steele-source-text-v1
 *   STEELE_RESEARCH_COLLECTION_INDEX?     default steele-research-collection-v1 (#225)
 *
 * Output is one JSON line naming each resource and whether it was created,
 * unchanged or updated.
 */
import { RESEARCH_STREAM } from "../events/research-completed-event.js";
import { RESEARCH_REINDEX_SUBJECT } from "../events/research-reindex-event.js";
import {
  describeSetupError,
  elasticsearchConnection,
  natsConnection,
} from "../config/credentials.js";
import { z } from "zod";
import { FULLTEXT_INDEX_MAPPING, FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import {
  RESEARCH_COLLECTION_INDEX_MAPPING,
  RESEARCH_COLLECTION_INDEX_V1,
} from "../research/research-index.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { DEFAULT_DISCOVERY_SUBJECT } from "../controllers/nats-discovery.js";
import {
  provisionDiscoveryStream,
  provisionDurableConsumer,
} from "../controllers/nats-provision.js";
import { NatsController } from "../controllers/nats.js";
import { ARTICLE_APPROVED_SUBJECT, PUBLICATION_STREAM } from "../events/article-approved-event.js";
import { STREAMS, streamName } from "../events/registry.js";
import { TEXT_READY_SUBJECT } from "../events/text-ready-event.js";

/** Broker redelivery budget for destination consumers (#315). */
const PUBLISHER_MAX_DELIVER = 300;

const EnvSchema = z.object({
  STEELE_COLLECT_CONSUMER: z.string().min(1).default("steele-collector"),
  STEELE_INDEX_CONSUMER: z.string().min(1).default("steele-indexer"),
  STEELE_RESEARCH_REINDEX_CONSUMER: z.string().min(1).default("steele-research-indexer"),
  STEELE_PUBLISHER_CONSUMERS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  STEELE_PUBLISHER_NEW_ONLY_CONSUMERS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  STEELE_FULLTEXT_INDEX: z.string().min(1).default(FULLTEXT_INDEX_V1),
  STEELE_RESEARCH_COLLECTION_INDEX: z.string().min(1).default(RESEARCH_COLLECTION_INDEX_V1),
});

async function main(): Promise<number> {
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`provision: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  let names: Map<string, string>;
  try {
    names = new Map(STREAMS.map((def) => [def.name, streamName(def)]));
  } catch (error) {
    console.error(
      `provision: ${error instanceof Error ? error.message : "invalid stream configuration"}`,
    );
    return 2;
  }
  let natsConn;
  let esConn;
  try {
    natsConn = natsConnection();
    esConn = elasticsearchConnection();
  } catch (error) {
    console.error(`provision: ${describeSetupError(error)}`);
    return 2;
  }

  const nats = new NatsController(natsConn.url, natsConn.token);
  let es: ElasticsearchController | undefined;
  const report: Record<string, string> = {};
  try {
    es = new ElasticsearchController(esConn.url, esConn.apiKey);
    await nats.connect("steele-provision");
    // Streams come from the shared registry (#209); names honour configured overrides.
    for (const def of STREAMS) {
      report[`stream:${def.name}`] = await provisionDiscoveryStream(
        nats,
        {
          name: names.get(def.name)!,
          subjects: [...def.subjects],
        },
        // Registry streams are ours: adding a new subject is a non-destructive
        // upgrade that keeps retained messages. Removal still conflicts.
        { allowAdditiveSubjects: true },
      );
    }
    report.collectConsumer = await provisionDurableConsumer(nats, {
      stream: names.get("STEELE_DISCOVERY")!,
      name: c.STEELE_COLLECT_CONSUMER,
      filterSubject: DEFAULT_DISCOVERY_SUBJECT,
    });
    report.indexConsumer = await provisionDurableConsumer(nats, {
      stream: names.get("STEELE_CONTENT")!,
      name: c.STEELE_INDEX_CONSUMER,
      filterSubject: TEXT_READY_SUBJECT,
    });
    report.reindexConsumer = await provisionDurableConsumer(nats, {
      stream: names.get(RESEARCH_STREAM)!,
      name: c.STEELE_RESEARCH_REINDEX_CONSUMER,
      filterSubject: RESEARCH_REINDEX_SUBJECT,
    });
    // One durable consumer per destination, each with its own position (#315).
    const publisherConsumers = [
      ...c.STEELE_PUBLISHER_CONSUMERS.map((name) => ({ name, newOnly: false })),
      ...c.STEELE_PUBLISHER_NEW_ONLY_CONSUMERS.map((name) => ({ name, newOnly: true })),
    ];
    for (const { name, newOnly } of publisherConsumers) {
      report[`publisherConsumer:${name}`] = await provisionDurableConsumer(nats, {
        stream: names.get(PUBLICATION_STREAM)!,
        name,
        newOnly,
        filterSubject: ARTICLE_APPROVED_SUBJECT,
        // A finite budget sized above the handler's own: a restart can leave a
        // claim "busy" for its 10-minute lease (about 120 redeliveries at 5 s),
        // and the handler terms after five claimed attempts. Failures before a
        // claim (an unreadable artifact) still stop, after about 2.5 hours of
        // 30-second retries, instead of looping forever.
        maxDeliver: PUBLISHER_MAX_DELIVER,
      });
    }
    report.fulltextIndex = await es.provisionIndex(c.STEELE_FULLTEXT_INDEX, FULLTEXT_INDEX_MAPPING);
    report.researchIndex = await es.provisionIndex(
      c.STEELE_RESEARCH_COLLECTION_INDEX,
      RESEARCH_COLLECTION_INDEX_MAPPING,
    );
    // "unchanged" can mean a backing index without its alias: confirm the
    // alias itself answers before reporting success.
    await es.search(c.STEELE_FULLTEXT_INDEX, { match_all: {} }, { size: 1 });
    report.fulltextAlias = "verified";
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
