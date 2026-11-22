/**
 * Git-triggered captured-post indexer health probe (#326).
 *
 *   node dist/cli/probe-captured-index.js          readiness: one JSON line; exit 0 ready, 1 not
 *   node dist/cli/probe-captured-index.js --live   liveness only
 *
 * Reads the worker's own configuration: STEELE_ARCHIVE_PATH,
 * STEELE_ARCHIVE_REPOSITORY, STEELE_CAPTURED_INDEX_CHECKPOINT,
 * ELASTICSEARCH_URL / ELASTICSEARCH_API_KEY, STEELE_FULLTEXT_INDEX (default
 * steele-source-text-v1) and STEELE_STATE_PATH. Optional
 * STEELE_PROBE_TIMEOUT_MS bounds each check. Read-only; no paths, URLs or
 * credentials in the output.
 */
import { elasticsearchConnection } from "../config/credentials.js";
import { FULLTEXT_INDEX_V1 } from "../content/fulltext-document.js";
import { probeCapturedIndex } from "../diagnostics/captured-index-probe.js";

async function main(): Promise<number> {
  if (process.argv.includes("--live")) {
    console.log(JSON.stringify({ role: "captured-index-worker", live: true }));
    return 0;
  }
  const env = process.env;
  let es;
  try {
    es = elasticsearchConnection();
  } catch {
    es = undefined; // reported as not-configured, never echoed
  }
  const timeout = Number(env.STEELE_PROBE_TIMEOUT_MS);
  const report = await probeCapturedIndex({
    ...(env.STEELE_ARCHIVE_PATH && env.STEELE_ARCHIVE_REPOSITORY
      ? { archive: { path: env.STEELE_ARCHIVE_PATH, repository: env.STEELE_ARCHIVE_REPOSITORY } }
      : {}),
    ...(env.STEELE_CAPTURED_INDEX_CHECKPOINT
      ? { checkpointPath: env.STEELE_CAPTURED_INDEX_CHECKPOINT }
      : {}),
    ...(es ? { elasticsearch: es } : {}),
    index: env.STEELE_FULLTEXT_INDEX || FULLTEXT_INDEX_V1,
    ...(env.STEELE_STATE_PATH ? { statePath: env.STEELE_STATE_PATH } : {}),
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
    console.log(JSON.stringify({ role: "captured-index-worker", live: true, ready: false }));
    process.exit(1);
  },
);
