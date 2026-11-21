import type { OperationStore } from "../controllers/operation-store.js";

/**
 * Durable recovery identity for a stopped article run (#480).
 *
 * A credit-stopped workflow is finished under its normal deterministic key, so
 * submitting the same revision again only reattaches to the finished run. A
 * recovery therefore uses one additional workflow key derived from the normal
 * key, recorded once in the state controller. Duplicate clicks and reconnects
 * reuse that recorded identity; they never mint a new suffix or start a second
 * run. Prior state is untouched, and idempotent stages reuse their paid
 * artifacts.
 */

export const RECOVERY_RUN_SUFFIX = "~recovered";

/** One recovery workflow key per normal run key. Stable and inspectable. */
export const recoveryWorkflowKey = (runKey: string): string =>
  `${runKey}${RECOVERY_RUN_SUFFIX}`;

/** State-controller key holding the recorded recovery identity. */
export const recoveryOperationKey = (runKey: string): string => `article-recovery:${runKey}`;

export interface RecoveryIdentity {
  /** Workflow key the recovery submission uses. */
  workflowKey: string;
  recordedAt: string;
}

export interface RecoveryIdentities {
  /**
   * Return the recorded recovery identity for a run, creating and recording it
   * once. A concurrent creator's identity wins; this call then returns theirs.
   */
  ensure(runKey: string): Promise<{ identity: RecoveryIdentity; created: boolean }>;
  /** The recorded identity, without creating anything. */
  recorded(runKey: string): RecoveryIdentity | undefined;
}

const parse = (artifact: unknown): RecoveryIdentity | undefined => {
  if (artifact === null || typeof artifact !== "object") return undefined;
  const record = artifact as { workflowKey?: unknown; recordedAt?: unknown };
  return typeof record.workflowKey === "string" &&
    record.workflowKey.length > 0 &&
    typeof record.recordedAt === "string"
    ? { workflowKey: record.workflowKey, recordedAt: record.recordedAt }
    : undefined;
};

export function recoveryIdentities(
  operations: Pick<OperationStore, "claim" | "complete" | "operationStatus">,
  options: { owner?: string; now?: () => Date; leaseMs?: number } = {},
): RecoveryIdentities {
  const now = options.now ?? (() => new Date());
  const owner = options.owner ?? "dashboard-recovery";
  const recorded = (runKey: string): RecoveryIdentity | undefined => {
    const status = operations.operationStatus(recoveryOperationKey(runKey));
    return status?.status === "completed" ? parse(status.artifact) : undefined;
  };
  return {
    recorded,
    async ensure(runKey) {
      const existing = recorded(runKey);
      if (existing) return { identity: existing, created: false };

      const claim = operations.claim(
        recoveryOperationKey(runKey),
        owner,
        options.leaseMs ?? 60_000,
        3,
      );
      if (claim.kind === "completed" || claim.kind === "exhausted") {
        const raced = recorded(runKey);
        if (raced) return { identity: raced, created: false };
        throw new Error("recovery-unavailable");
      }
      if (claim.kind === "busy") {
        // Another submission is recording it right now; never start a second.
        throw new Error("recovery-busy");
      }
      const identity: RecoveryIdentity = {
        workflowKey: recoveryWorkflowKey(runKey),
        recordedAt: now().toISOString(),
      };
      try {
        operations.complete(claim.claim, identity, []);
        return { identity, created: true };
      } catch {
        // A concurrent creator completed first: reuse their identity.
        const raced = recorded(runKey);
        if (raced) return { identity: raced, created: false };
        throw new Error("recovery-unavailable");
      }
    },
  };
}
