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
 * The state inspection is synchronous SQLite, so it runs in a worker thread:
 * a large or slow store would otherwise block the event loop, delay every
 * other check and outlive its own deadline. Aborting the check terminates the
 * worker.
 *
 * Output is allowlisted and carries no configuration: no credentials,
 * connection URLs, hosts, filesystem paths or raw exception text. The combined
 * view is an observation across controllers, not an atomic snapshot.
 */
import { Worker } from "node:worker_threads";
import type { ElasticsearchConnection, NatsConnection } from "../config/credentials.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { NatsController } from "../controllers/nats.js";
import type { OperationStatusCount } from "../controllers/operation-store.js";

export const RUNTIME_STATUS_SCHEMA_VERSION = 1;

/** Upper bound for one dependency check, so a hung client cannot stall the report. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

export type CheckState = "healthy" | "not-configured" | "unavailable";

/** A controller's existing read-only connectivity probe. */
export interface HealthProbe {
  check(signal?: AbortSignal): Promise<void>;
}

/** The state controller's narrow read-only inspection surface. */
export interface StateCountsProbe {
  readCounts(signal?: AbortSignal): Promise<OperationStatusCount[]>;
}

export interface StateProbeOptions {
  /**
   * The worker entry. Defaults to the compiled module beside this one; tests
   * point at the TypeScript source instead.
   */
  workerUrl?: string | URL;
  /** Node flags for the worker process (tests load TypeScript through tsx). */
  execArgv?: string[];
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

const countsFromMessage = (message: unknown): OperationStatusCount[] | undefined => {
  if (message === null || typeof message !== "object") return undefined;
  const counts = (message as { counts?: unknown }).counts;
  if (!Array.isArray(counts)) return undefined;
  if (
    !counts.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { status?: unknown }).status === "string" &&
        typeof (entry as { count?: unknown }).count === "number",
    )
  ) {
    return undefined;
  }
  return counts as OperationStatusCount[];
};

function readCountsInWorker(
  path: string,
  workerUrl: string | URL,
  signal: AbortSignal | undefined,
  execArgv: string[] | undefined,
): Promise<OperationStatusCount[]> {
  if (signal?.aborted) return Promise.reject(new Error("state inspection aborted"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { path },
      ...(execArgv ? { execArgv } : {}),
    });
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => undefined);
      outcome();
    };
    const onAbort = () =>
      finish(() => reject(new Error("inspection aborted")));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: unknown) => {
      const counts = countsFromMessage(message);
      if (counts) finish(() => resolve(counts));
      else finish(() => reject(new Error("operation store unavailable")));
    });
    worker.once("error", () => finish(() => reject(new Error("operation store unavailable"))));
    worker.once("exit", () => finish(() => reject(new Error("operation store unavailable"))));
  });
}

/**
 * A state probe for one configured path. Each call inspects in a worker with a
 * freshly opened read-only connection, so a missing or incompatible database
 * becomes an unavailable check and nothing is created or migrated.
 */
export function stateProbeFor(path: string, options: StateProbeOptions = {}): StateCountsProbe {
  const workerUrl = options.workerUrl ?? new URL("./state-probe-worker.js", import.meta.url);
  return {
    readCounts: (signal) => readCountsInWorker(path, workerUrl, signal, options.execArgv),
  };
}

/** Narrow controller surface the diagnostic needs: a check and a release. */
export interface ConnectivityController {
  check(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/**
 * NATS connectivity probe. The deadline signal reaches the controller, which
 * closes the socket on abort, so a silent broker cannot outlive the check.
 */
export function natsProbe(
  connection: NatsConnection,
  controller: ConnectivityController = new NatsController(connection.url, connection.token),
): HealthProbe {
  return { check: (signal) => controller.check(signal) };
}

/** Search connectivity probe. The deadline signal reaches the request. */
export function elasticsearchProbe(
  connection: ElasticsearchConnection,
  controller: ConnectivityController = new ElasticsearchController(
    connection.url,
    connection.apiKey,
  ),
): HealthProbe {
  return {
    check: async (signal) => {
      try {
        await controller.check(signal);
      } finally {
        await controller.close();
      }
    },
  };
}

const TIMED_OUT = Symbol("timed-out");

/** Resolve to `TIMED_OUT` and abort the work when its budget is spent. */
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<typeof TIMED_OUT>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(TIMED_OUT), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function probe(
  name: "nats" | "elasticsearch",
  dependency: HealthProbe | undefined,
  timeoutMs: number,
): Promise<RuntimeStatusCheck> {
  if (!dependency) return { name, status: "not-configured" };
  try {
    const outcome = await bounded((signal) => dependency.check(signal), timeoutMs);
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
  const started = Date.now();
  try {
    const counts = await bounded((signal) => dependency.readCounts(signal), timeoutMs);
    // A probe that cannot be interrupted may still answer late; that answer is
    // not evidence of a healthy bounded check.
    if (counts === TIMED_OUT || Date.now() - started > timeoutMs) {
      return { name: "state", status: "unavailable" };
    }
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
  return report.checks.every(
    (check) => check.status === "healthy" || check.status === "not-configured",
  )
    ? 0
    : 1;
}

/** Human-readable rendering of the same allowlisted fields as the JSON report. */
export function renderRuntimeStatus(report: RuntimeStatusReport): string {
  const lines = [`runtime status (observed ${report.observedAt}, schema ${report.schemaVersion})`];
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
