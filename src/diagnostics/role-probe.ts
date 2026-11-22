/**
 * Role-specific health probes (#323).
 *
 * A probe has two answers. Liveness is local and cheap: the probe process
 * started and the role is configured. Readiness runs each dependency check
 * through its existing controller, bounded in time and recorded separately,
 * so one failure never hides another and a dependency outage is reported
 * rather than turned into a restart loop.
 *
 * Probes are read-only: they never provision, consume, acknowledge, publish,
 * repair, start a run or call a model. Output is allowlisted: fixed check
 * names and states only, never URLs, hosts, paths, credentials or raw errors.
 */
import { DEFAULT_CHECK_TIMEOUT_MS, type CheckState } from "./runtime-status.js";

export const ROLE_PROBE_SCHEMA_VERSION = 1;

export interface RoleCheck {
  /** Fixed, allowlisted name, e.g. `broker`. */
  name: string;
  /** Undefined when the role's configuration does not provide this dependency. */
  run?: (signal: AbortSignal) => Promise<void>;
}

export interface RoleProbeReport {
  schemaVersion: typeof ROLE_PROBE_SCHEMA_VERSION;
  role: string;
  live: true;
  /** True only when every check is healthy. */
  ready: boolean;
  checks: Record<string, CheckState>;
  /** Allowlisted facts a role adds (times and counts only). */
  details?: Record<string, string | number>;
}

async function bounded(
  run: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): Promise<CheckState> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<CheckState>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("unavailable");
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      run(controller.signal).then(
        () => "healthy" as const,
        () => "unavailable" as const,
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run every check concurrently, each within its own bound. */
export async function runRoleProbe(
  role: string,
  checks: RoleCheck[],
  timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
  details?: Record<string, string | number>,
): Promise<RoleProbeReport> {
  const states = await Promise.all(
    checks.map(async (c) => [c.name, c.run ? await bounded(c.run, timeoutMs) : "not-configured"]),
  );
  const result = Object.fromEntries(states) as Record<string, CheckState>;
  return {
    schemaVersion: ROLE_PROBE_SCHEMA_VERSION,
    role,
    live: true,
    ready: Object.values(result).every((s) => s === "healthy"),
    checks: result,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}
