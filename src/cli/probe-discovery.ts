/**
 * Discovery poller health probe (#327).
 *
 *   node dist/cli/probe-discovery.js           readiness: one JSON line; exit 0 ready, 1 not
 *   node dist/cli/probe-discovery.js --live    liveness only
 *
 * Reads STEELE_DISCOVERY_STATUS_PATH (the runner's status file) and
 * STEELE_POLL_INTERVAL_MS. Optional STEELE_PROBE_STALE_AFTER_MS (default three
 * poll intervals) and STEELE_PROBE_MAX_FAILURES (default 3). Read-only; output
 * carries no paths, feed URLs or hosts.
 */
import { probeDiscovery } from "../diagnostics/discovery-probe.js";

const positive = (raw: string | undefined) => {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : undefined;
};

async function main(): Promise<number> {
  if (process.argv.includes("--live")) {
    console.log(JSON.stringify({ role: "discovery-poller", live: true }));
    return 0;
  }
  const env = process.env;
  const interval = positive(env.STEELE_POLL_INTERVAL_MS);
  const stale = positive(env.STEELE_PROBE_STALE_AFTER_MS);
  const failures = positive(env.STEELE_PROBE_MAX_FAILURES);
  const report = await probeDiscovery({
    ...(env.STEELE_DISCOVERY_STATUS_PATH ? { statusPath: env.STEELE_DISCOVERY_STATUS_PATH } : {}),
    ...(interval ? { pollIntervalMs: interval } : {}),
    ...(stale ? { staleAfterMs: stale } : {}),
    ...(failures ? { maxConsecutiveFailures: failures } : {}),
  });
  console.log(JSON.stringify(report));
  return report.ready ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  () => {
    console.log(JSON.stringify({ role: "discovery-poller", live: true, ready: false }));
    process.exit(1);
  },
);
