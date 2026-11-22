/**
 * Legacy text-ready indexer health probe (#325).
 *
 *   node dist/cli/probe-text-ready-indexer.js          readiness: one JSON line; exit 0 ready, 1 not
 *   node dist/cli/probe-text-ready-indexer.js --live   liveness only
 *
 * Reads the indexer's own configuration: NATS_URL / NATS_TOKEN,
 * STEELE_INDEX_STREAM, STEELE_INDEX_CONSUMER, ELASTICSEARCH_URL /
 * ELASTICSEARCH_API_KEY and STEELE_FULLTEXT_INDEX (default
 * steele-source-text-v1). Optional STEELE_PROBE_TIMEOUT_MS. Read-only; no
 * URLs or credentials in the output.
 */
import { elasticsearchConnection, natsConnection } from "../config/credentials.js";
import { FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import { probeTextReadyIndexer } from "../diagnostics/text-ready-indexer-probe.js";

const optional = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined; // reported as not-configured, never echoed
  }
};

async function main(): Promise<number> {
  if (process.argv.includes("--live")) {
    console.log(JSON.stringify({ role: "text-ready-indexer", live: true }));
    return 0;
  }
  const env = process.env;
  const nats = optional(() => natsConnection());
  const es = optional(() => elasticsearchConnection());
  const timeout = Number(env.STEELE_PROBE_TIMEOUT_MS);
  const report = await probeTextReadyIndexer({
    ...(nats ? { nats } : {}),
    ...(env.STEELE_INDEX_STREAM ? { stream: env.STEELE_INDEX_STREAM } : {}),
    ...(env.STEELE_INDEX_CONSUMER ? { consumer: env.STEELE_INDEX_CONSUMER } : {}),
    ...(es ? { elasticsearch: es } : {}),
    index: env.STEELE_FULLTEXT_INDEX || FULLTEXT_INDEX_V1,
    ...(Number.isInteger(timeout) && timeout >= 100 && timeout <= 60_000
      ? { timeoutMs: timeout }
      : {}),
  });
  console.log(JSON.stringify(report));
  return report.ready ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  () => {
    console.log(JSON.stringify({ role: "text-ready-indexer", live: true, ready: false }));
    process.exit(1);
  },
);
