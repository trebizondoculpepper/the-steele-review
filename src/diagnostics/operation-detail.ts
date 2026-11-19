/**
 * Read-only inspection of one recorded operation (#173).
 *
 * Shows the operation's reported domain status, attempts, sanitised failure
 * code, lease expiry, logical artifact reference and pending-event counts from
 * the state controller's bounded inspection API. Unknown keys are explicitly
 * not-found, never "completed". Owners, payloads and physical paths are never
 * part of the allowlist.
 *
 * Like `status`, the inspection runs off the main thread and is bounded: a
 * slow store cannot block or outlive the deadline.
 */
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  TIMED_OUT,
  withDeadline,
  type OperationProbe,
} from "./runtime-status.js";
import type { OperationInspection } from "../controllers/operation-store.js";

export const OPERATION_REPORT_SCHEMA_VERSION = 1;

/** The state controller's own key bound; anything else is invalid usage. */
export const MAX_OPERATION_KEY_LENGTH = 512;

export function isOperationKey(key: string): boolean {
  return key.length >= 1 && key.length <= MAX_OPERATION_KEY_LENGTH;
}

export interface OperationArguments {
  /** Present when a positional key was supplied. */
  key?: string;
  json: boolean;
  help: boolean;
}

export type OperationArgumentResult = { ok: true; args: OperationArguments } | { ok: false };

/**
 * Parse `operation <key> [--json]`. Unknown options are rejected rather than
 * treated as keys, so a mistyped flag is a usage error (exit 2). `--` ends
 * option parsing for keys that begin with a dash.
 */
export function parseOperationArguments(argv: string[]): OperationArgumentResult {
  let key: string | undefined;
  let json = false;
  let help = false;
  let optionsEnded = false;
  for (const arg of argv) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === "--help" || arg === "-h")) {
      help = true;
      continue;
    }
    if (!optionsEnded && arg === "--json") {
      json = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) return { ok: false };
    if (key !== undefined || !isOperationKey(arg)) return { ok: false };
    key = arg;
  }
  return { ok: true, args: { ...(key === undefined ? {} : { key }), json, help } };
}

export type OperationReport =
  | {
      schemaVersion: typeof OPERATION_REPORT_SCHEMA_VERSION;
      observedAt: string;
      status: "found";
      operation: OperationInspection;
    }
  | {
      schemaVersion: typeof OPERATION_REPORT_SCHEMA_VERSION;
      observedAt: string;
      status: "not-found";
    }
  | {
      schemaVersion: typeof OPERATION_REPORT_SCHEMA_VERSION;
      observedAt: string;
      status: "unavailable";
    };

/**
 * Inspect one operation. `unavailable` covers missing, incompatible, changed or
 * timed-out state; a value in the domain (including `failed`) is `found`.
 */
export async function inspectOperation(
  probe: OperationProbe | undefined,
  key: string,
  options: { now?: () => Date; timeoutMs?: number } = {},
): Promise<OperationReport> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  if (!probe)
    return { schemaVersion: OPERATION_REPORT_SCHEMA_VERSION, observedAt, status: "unavailable" };
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const started = Date.now();
  try {
    const operation = await withDeadline((signal) => probe.readOperation(key, signal), timeoutMs);
    if (operation === TIMED_OUT || Date.now() - started > timeoutMs) {
      return { schemaVersion: OPERATION_REPORT_SCHEMA_VERSION, observedAt, status: "unavailable" };
    }
    if (operation === null) {
      return { schemaVersion: OPERATION_REPORT_SCHEMA_VERSION, observedAt, status: "not-found" };
    }
    return {
      schemaVersion: OPERATION_REPORT_SCHEMA_VERSION,
      observedAt,
      status: "found",
      operation,
    };
  } catch {
    return { schemaVersion: OPERATION_REPORT_SCHEMA_VERSION, observedAt, status: "unavailable" };
  }
}

/**
 * 0 for a found record, even when its domain status is failed: the transport
 * outcome is separate from processing success. 1 for not-found or unavailable.
 */
export function operationExitCode(report: OperationReport): 0 | 1 {
  return report.status === "found" ? 0 : 1;
}

/** Human-readable rendering of the same allowlisted fields as the JSON report. */
export function renderOperation(report: OperationReport): string {
  const header = `operation inspection (observed ${report.observedAt}, schema ${report.schemaVersion})`;
  if (report.status !== "found") return `${header}\n${report.status}`;
  const operation = report.operation;
  const artifact = operation.artifact;
  const lines = [
    header,
    `key: ${operation.key}`,
    `status: ${operation.status}`,
    `attempts: ${operation.attempts}/${operation.maxAttempts}`,
    `exhausted: ${operation.exhausted ? "yes" : "no"}`,
  ];
  if (operation.errorCode) lines.push(`error code: ${operation.errorCode}`);
  if (operation.leaseExpiresAt) lines.push(`lease expires: ${operation.leaseExpiresAt}`);
  if (artifact?.kind === "reference") {
    lines.push(
      `artifact: ${artifact.repository} ${artifact.commit.slice(0, 12)}:${artifact.path} (${artifact.hash.slice(0, 19)}...)`,
    );
  } else if (artifact?.kind === "partial") {
    const parts = [artifact.commit?.slice(0, 12), artifact.path].filter(
      (part): part is string => typeof part === "string",
    );
    lines.push(`artifact: partial ${parts.join(" ")}`.trim());
  }
  lines.push(
    `pending events: pending ${operation.pendingEvents.pending}, sent ${operation.pendingEvents.sent}`,
  );
  return lines.join("\n");
}
