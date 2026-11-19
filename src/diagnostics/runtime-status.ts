/**
 * Read-only runtime status (#172).
 *
 * Composes the narrow health probes of the state, NATS and Elasticsearch
 * controllers into one best-effort report. Each dependency is bounded in time
 * and recorded separately, so one failure never hides another. This module
 * never provisions, consumes, publishes, retries, acquires claims or calls a
 * model: it only asks each controller whether it is reachable and reads the
 * state controller's pipeline counts.
 *
 * Output is allowlisted and carries no configuration: no credentials,
 * connection URLs, hosts, filesystem paths or raw exception text. The combined
 * view is an observation across controllers, not an atomic snapshot.
 */
import { OperationInspector, type OperationStatusCount } from "../controllers/operation-store.js";

export const RUNTIME_STATUS_SCHEMA_VERSION = 1;

/** Upper bound for one dependency check, so a hung client cannot stall the report. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

export type CheckState = "healthy" | "not-configured" | "unavailable";

/** A controller's existing read-only connectivity probe. */
export interface HealthProbe {
  check(): Promise<void>;
}

/** The state controller's narrow read-only inspection surface. */
export interface StateCountsProbe {
  statusCounts(): OperationStatusCount[];
}

/**
 * A state probe for one configured path. Opens the store read-only on each
 * call and closes it, so a missing or incompatible database becomes an
 * unavailable check and nothing is created or migrated.
 */
export function stateProbeFor(path: string): StateCountsProbe {
  return {
    statusCounts() {
      const opened = OperationInspector.open(path);
      if (opened.status !== "available") throw new Error("operation store unavailable");
      try {
        return opened.inspector.statusCounts();
      } finally {
        opened.inspector.close();
      }
    },
  };
}

export interface RuntimeStatusDependencies {
  /** Absent when no operation store is configured. */
  state?: StateCountsProbe;
  /** Absent when no broker is configured. */
  nats?: HealthProbe;
  /** Absent when no search cluster is configured. */
  elasticsearch?: HealthProbe;
}

export type RuntimeStatusCheck =
  | { name: "state"; status: "healthy"; counts: OperationStatusCount[] }
  | { name: "state"; status: "unavailable" | "not-configured" }
  | { name: "nats" | "elasticsearch"; status: CheckState };

export interface RuntimeStatusReport {
  schemaVersion: typeof RUNTIME_STATUS_SCHEMA_VERSION;
  /** When the checks were collected; one observation, not an atomic snapshot. */
  observedAt: string;
  checks: RuntimeStatusCheck[];
}

const TIMED_OUT = Symbol("timed-out");

/** Resolve to `TIMED_OUT` rather than waiting on a probe past its budget. */
async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probe(
  name: "nats" | "elasticsearch",
  dependency: HealthProbe | undefined,
  timeoutMs: number,
): Promise<RuntimeStatusCheck> {
  if (!dependency) return { name, status: "not-configured" };
  try {
    const outcome = await bounded(dependency.check(), timeoutMs);
    return { name, status: outcome === TIMED_OUT ? "unavailable" : "healthy" };
  } catch {
    // A client error may contain an endpoint or credential: never surface it.
    return { name, status: "unavailable" };
  }
}

async function stateCheck(
  dependency: StateCountsProbe | undefined,
  timeoutMs: number,
): Promise<RuntimeStatusCheck> {
  if (!dependency) return { name: "state", status: "not-configured" };
  try {
    const counts = await bounded(
      Promise.resolve().then(() => dependency.statusCounts()),
      timeoutMs,
    );
    if (counts === TIMED_OUT) return { name: "state", status: "unavailable" };
    return { name: "state", status: "healthy", counts };
  } catch {
    // Missing, incompatible or changed state is unavailable, never a crash.
    return { name: "state", status: "unavailable" };
  }
}

/**
 * Collect every configured check. All three run concurrently and resolve
 * independently; a missing or failing dependency leaves the others intact.
 */
export async function collectRuntimeStatus(
  dependencies: RuntimeStatusDependencies,
  options: { now?: () => Date; timeoutMs?: number } = {},
): Promise<RuntimeStatusReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const checks = await Promise.all([
    stateCheck(dependencies.state, timeoutMs),
    probe("nats", dependencies.nats, timeoutMs),
    probe("elasticsearch", dependencies.elasticsearch, timeoutMs),
  ]);
  return {
    schemaVersion: RUNTIME_STATUS_SCHEMA_VERSION,
    observedAt: (options.now ?? (() => new Date()))().toISOString(),
    checks,
  };
}

/** 0 when every configured check is healthy; 1 when any is unavailable. */
export function runtimeStatusExitCode(report: RuntimeStatusReport): 0 | 1 {
  return report.checks.every((check) => check.status === "healthy" || check.status === "not-configured")
    ? 0
    : 1;
}

/** Human-readable rendering of the same allowlisted fields as the JSON report. */
export function renderRuntimeStatus(report: RuntimeStatusReport): string {
  const lines = [
    `runtime status (observed ${report.observedAt}, schema ${report.schemaVersion})`,
  ];
  for (const check of report.checks) {
    if (check.name === "state" && check.status === "healthy") {
      const counts =
        check.counts.length === 0
          ? "no operations recorded"
          : check.counts.map((c) => `${c.status} ${c.count}`).join(", ");
      lines.push(`state: healthy (${counts})`);
      continue;
    }
    lines.push(`${check.name}: ${check.status}`);
  }
  return lines.join("\n");
}
