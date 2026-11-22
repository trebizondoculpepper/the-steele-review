/**
 * Collector health probe (#324).
 *
 *   node dist/cli/probe-collector.js           readiness: one JSON line; exit 0 ready, 1 not
 *   node dist/cli/probe-collector.js --live    liveness only: no dependency is contacted
 *
 * Reads the collector's own configuration (the same variables as
 * collect-worker): NATS_URL / NATS_TOKEN, STEELE_COLLECT_STREAM,
 * STEELE_COLLECT_CONSUMER, STEELE_ARCHIVE_PATH, STEELE_ARCHIVE_REPOSITORY,
 * STEELE_STATE_PATH. Optional STEELE_PROBE_TIMEOUT_MS bounds each check.
 *
 * Read-only and side-effect-free; output names only fixed checks and states,
 * never URLs, hosts, paths or credentials.
 */
import { natsConnection } from "../config/credentials.js";
import { probeCollector } from "../diagnostics/collector-probe.js";

async function main(): Promise<number> {
  if (process.argv.includes("--live")) {
    console.log(JSON.stringify({ role: "collector", live: true }));
    return 0;
  }
  const env = process.env;
  let nats;
  try {
    nats = natsConnection();
  } catch {
    nats = undefined; // reported as not-configured, never echoed
  }
  const timeout = Number(env.STEELE_PROBE_TIMEOUT_MS);
  const report = await probeCollector({
    ...(nats ? { nats } : {}),
    ...(env.STEELE_COLLECT_STREAM ? { stream: env.STEELE_COLLECT_STREAM } : {}),
    ...(env.STEELE_COLLECT_CONSUMER ? { consumer: env.STEELE_COLLECT_CONSUMER } : {}),
    ...(env.STEELE_ARCHIVE_PATH && env.STEELE_ARCHIVE_REPOSITORY
      ? { archive: { path: env.STEELE_ARCHIVE_PATH, repository: env.STEELE_ARCHIVE_REPOSITORY } }
      : {}),
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
    console.log(JSON.stringify({ role: "collector", live: true, ready: false }));
    process.exit(1);
  },
);
