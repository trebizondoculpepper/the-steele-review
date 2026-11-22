import { readDiscoveryStatus } from "../discovery/status.js";
import { runRoleProbe, type RoleProbeReport } from "./role-probe.js";

/** Default poll interval of the discovery runner (STEELE_POLL_INTERVAL_MS). */
export const DEFAULT_POLL_INTERVAL_MS = 300_000;
/** Consecutive failed polls tolerated before the poller is reported not ready. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Discovery poller readiness (#327), from the sanitised status file the
 * runner writes after each poll (#376):
 * - `status`: the file is present and valid;
 * - `poll`: the last completed poll is recent (an unchanged feed is a
 *   completed poll, so it is healthy);
 * - `failures`: consecutive failed polls stay below a bound.
 * Read-only: the feed and broker are never contacted.
 */
export async function probeDiscovery(config: {
  statusPath?: string;
  pollIntervalMs?: number;
  /** Default: three poll intervals. */
  staleAfterMs?: number;
  maxConsecutiveFailures?: number;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<RoleProbeReport> {
  const path = config.statusPath;
  const staleAfter = config.staleAfterMs ?? 3 * (config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const maxFailures = config.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const now = (config.now ?? (() => new Date()))();
  // Read once; every check judges the same record.
  const status = path ? await readDiscoveryStatus(path) : undefined;
  const lastPollAt = status
    ? (status.lastPollAt ?? (status.runs > 0 ? status.at : undefined))
    : undefined;
  const fail = async () => {
    throw new Error("not ready");
  };
  const ok = async () => undefined;
  const details: Record<string, string | number> = {};
  if (status) {
    details.runs = status.runs;
    details.consecutiveFailures = status.consecutiveFailures;
    if (lastPollAt) details.lastPollAt = lastPollAt;
  }
  const recent =
    lastPollAt !== undefined &&
    Number.isFinite(Date.parse(lastPollAt)) &&
    now.getTime() - Date.parse(lastPollAt) <= staleAfter;
  return runRoleProbe(
    "discovery-poller",
    path
      ? [
          { name: "status", run: status ? ok : fail },
          { name: "poll", run: recent ? ok : fail },
          { name: "failures", run: status && status.consecutiveFailures < maxFailures ? ok : fail },
        ]
      : [{ name: "status" }, { name: "poll" }, { name: "failures" }],
    config.timeoutMs,
    details,
  );
}
