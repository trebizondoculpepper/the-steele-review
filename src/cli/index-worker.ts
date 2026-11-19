/**
 * Indexing worker entry point: consume text-ready events from a provisioned
 * durable JetStream consumer and index the committed text into the
 * full-text index. Composition only; logic lives in collection/.
 *
 * Configuration (environment):
 *   NATS_URL, NATS_TOKEN?             broker
 *   ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY?
 *   STEELE_ARCHIVE_PATH                local path of the private artifact repository
 *   STEELE_ARCHIVE_REPOSITORY          logical archive name recorded in references
 *   STEELE_STATE_PATH                  absolute path of the SQLite state file
 *   STEELE_INDEX_STREAM                stream holding text-ready events
 *   STEELE_INDEX_CONSUMER              durable consumer name (provisioned separately)
 *   STEELE_FULLTEXT_INDEX?             logical index (alias); defaults to steele-source-text-v1
 *   STEELE_INDEX_RETRY_DELAY_MS?       redelivery delay after a retryable failure
 *
 * Status lines are sanitised JSON. SIGTERM/SIGINT stop consumption after the
 * in-flight message and close connections.
 */
import {
  describeSetupError,
  elasticsearchConnection,
  natsConnection,
} from "../config/credentials.js";
import { hostname } from "node:os";
import { z } from "zod";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { NatsController } from "../controllers/nats.js";
import { OperationStore } from "../controllers/operation-store.js";
import { IndexingConsumer } from "../collection/indexing-consumer.js";

const EnvSchema = z.object({
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_INDEX_STREAM: z.string().min(1),
  STEELE_INDEX_CONSUMER: z.string().min(1),
  STEELE_FULLTEXT_INDEX: z.string().min(1).optional(),
  STEELE_INDEX_RETRY_DELAY_MS: z.coerce.number().int().positive().optional(),
});

async function main(): Promise<number> {
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`index-worker: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  let natsConn;
  let esConn;
  try {
    natsConn = natsConnection();
    esConn = elasticsearchConnection();
  } catch (error) {
    console.error(`index-worker: ${describeSetupError(error)}`);
    return 2;
  }

  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  const es = new ElasticsearchController(esConn.url, esConn.apiKey);
  const nats = new NatsController(natsConn.url, natsConn.token);
  const consumer = new IndexingConsumer({
    artifacts: new GitArtifactStore({
      repoPath: c.STEELE_ARCHIVE_PATH,
      repository: c.STEELE_ARCHIVE_REPOSITORY,
    }),
    index: es,
    indexName: c.STEELE_FULLTEXT_INDEX,
    operations,
    owner: `index-worker:${hostname()}:${process.pid}`,
    retryDelayMs: c.STEELE_INDEX_RETRY_DELAY_MS,
    onDecision: (d) => console.log(JSON.stringify({ event: "indexing", ...d })),
  });
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  try {
    await nats.connect("steele-index-worker");
    console.log(JSON.stringify({ event: "indexing", state: "consuming" }));
    await nats.consume(
      c.STEELE_INDEX_STREAM,
      c.STEELE_INDEX_CONSUMER,
      (m) => consumer.handle(m).then(() => undefined),
      abort.signal,
    );
    return 0;
  } catch {
    console.error(JSON.stringify({ event: "indexing", state: "failed" }));
    return 1;
  } finally {
    await nats.close();
    await es.close();
    operations.close();
    console.log(JSON.stringify({ event: "indexing", state: "stopped" }));
  }
}

process.exitCode = await main();
