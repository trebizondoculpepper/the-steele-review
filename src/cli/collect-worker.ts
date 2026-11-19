/**
 * Collection worker entry point: consume discovery events from a provisioned
 * durable JetStream consumer, capture each post's text through the Substack
 * controller, commit it to the archive and hand off text-ready events.
 * Composition only; logic lives in collection/worker.ts.
 *
 * Configuration (environment):
 *   NATS_URL, NATS_TOKEN?             broker
 *   STEELE_PUBLICATION_URL            public HTTPS publication base URL
 *   STEELE_PUBLICATION_ID             the publication this worker collects; others are handed back
 *   STEELE_ARCHIVE_PATH               local path of the private artifact repository
 *   STEELE_ARCHIVE_REPOSITORY         logical archive name recorded in references
 *   STEELE_STATE_PATH                 absolute path of the SQLite state file
 *   STEELE_COLLECT_STREAM             stream holding discovery events
 *   STEELE_COLLECT_CONSUMER           durable consumer name (provisioned separately)
 *   STEELE_COLLECT_RETRY_DELAY_MS?    redelivery delay after a retryable failure
 *   STEELE_COLLECT_DISPATCH_INTERVAL_MS?  pending handoff retry interval (default 30 s)
 *
 * No transcription provider is configured here: posts that need
 * transcription are recorded visibly as transcription-unavailable.
 * Output is one JSON line per outcome; no URLs with credentials are printed.
 */
import { hostname } from "node:os";
import { z } from "zod";
import { CollectionStore } from "../collection/collection-store.js";
import { CollectionWorker } from "../collection/worker.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { NatsController } from "../controllers/nats.js";
import { OperationStore } from "../controllers/operation-store.js";
import { SubstackContentCollector } from "../controllers/substack/collect.js";
import { parseDiscoveryEvent } from "../events/discovery-event.js";

const EnvSchema = z.object({
  NATS_URL: z.string().min(1),
  NATS_TOKEN: z.string().optional(),
  STEELE_PUBLICATION_URL: z.url({ protocol: /^https$/ }),
  STEELE_PUBLICATION_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
  STEELE_ARCHIVE_PATH: z.string().min(1),
  STEELE_ARCHIVE_REPOSITORY: z.string().min(1),
  STEELE_STATE_PATH: z.string().min(1),
  STEELE_COLLECT_STREAM: z.string().min(1),
  STEELE_COLLECT_CONSUMER: z.string().min(1),
  STEELE_COLLECT_RETRY_DELAY_MS: z.coerce.number().int().positive().optional(),
  STEELE_COLLECT_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().optional(),
});

async function main(): Promise<number> {
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) {
    const fields = [...new Set(env.error.issues.map((i) => i.path.join(".")))];
    console.error(`collect-worker: invalid or missing configuration: ${fields.join(", ")}`);
    return 2;
  }
  const c = env.data;
  const artifacts = new GitArtifactStore({
    repoPath: c.STEELE_ARCHIVE_PATH,
    repository: c.STEELE_ARCHIVE_REPOSITORY,
  });
  await artifacts.initialise();
  const operations = new OperationStore({ path: c.STEELE_STATE_PATH });
  const nats = new NatsController(c.NATS_URL, c.NATS_TOKEN || undefined);
  const worker = new CollectionWorker({
    store: new CollectionStore(operations, artifacts),
    operations,
    collector: new SubstackContentCollector({ publicationUrl: c.STEELE_PUBLICATION_URL }),
    publisher: nats,
    owner: `collect-worker:${hostname()}:${process.pid}`,
    ...(c.STEELE_COLLECT_RETRY_DELAY_MS ? { retryDelayMs: c.STEELE_COLLECT_RETRY_DELAY_MS } : {}),
    onOutcome: (outcome, item) =>
      console.log(
        JSON.stringify({
          event: "collection",
          outcome,
          ...(item ? { publicationId: item.publicationId, postId: item.postId } : {}),
        }),
      ),
  });
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  try {
    await nats.connect("steele-collect-worker");
    // Hand off anything left pending by an earlier run before consuming.
    await worker.dispatchPending(abort.signal);
    // Retry failed handoffs on a timer too, so a text-ready event left
    // pending is not stuck until the next discovery arrives.
    const retry = setInterval(() => {
      worker.dispatchPending(abort.signal).catch(() => undefined);
    }, c.STEELE_COLLECT_DISPATCH_INTERVAL_MS ?? 30_000);
    abort.signal.addEventListener("abort", () => clearInterval(retry), { once: true });
    console.log(JSON.stringify({ event: "collection", state: "consuming" }));
    await nats.consume(
      c.STEELE_COLLECT_STREAM,
      c.STEELE_COLLECT_CONSUMER,
      async (m) => {
        // One collector serves one publication. A discovery for any other
        // publication is handed back, never discarded: deployments give each
        // publication its own collector consumer, so this only signals
        // misconfiguration, and the warning makes it visible.
        let publicationId: string | undefined;
        try {
          publicationId = parseDiscoveryEvent(new TextDecoder().decode(m.data)).data?.publicationId;
        } catch {
          publicationId = undefined; // malformed: the worker terminates it
        }
        if (publicationId !== undefined && publicationId !== c.STEELE_PUBLICATION_ID) {
          console.error(
            JSON.stringify({ event: "collection", outcome: "other-publication", publicationId }),
          );
          m.nak(10 * 60_000);
          return;
        }
        await worker.handle(m, abort.signal);
      },
      abort.signal,
    );
    return 0;
  } catch {
    console.error(JSON.stringify({ event: "collection", state: "failed" }));
    return 1;
  } finally {
    abort.abort();
    await nats.close();
    operations.close();
    console.log(JSON.stringify({ event: "collection", state: "stopped" }));
  }
}

process.exitCode = await main();
