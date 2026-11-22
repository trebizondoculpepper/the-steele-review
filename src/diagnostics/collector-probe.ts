import type { NatsConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { brokerCheck, consumerCheck } from "./probe-checks.js";
import { runRoleProbe, type RoleProbeReport } from "./role-probe.js";
import { stateProbeFor, type StateProbeOptions } from "./runtime-status.js";

/**
 * Collector readiness (#324): the broker answers, the collector's own durable
 * consumer exists on its stream, the archive is a readable Git repository,
 * and the operation store opens read-only. Nothing is created, consumed,
 * acknowledged or migrated.
 */
export interface CollectorProbeConfig {
  /** Absent when the broker is not configured. */
  nats?: NatsConnection;
  stream?: string;
  consumer?: string;
  archive?: { path: string; repository: string };
  statePath?: string;
  stateOptions?: StateProbeOptions;
  timeoutMs?: number;
}

export async function probeCollector(config: CollectorProbeConfig): Promise<RoleProbeReport> {
  const nats = config.nats;
  return runRoleProbe(
    "collector",
    [
      { name: "broker", ...(nats ? { run: brokerCheck(nats) } : {}) },
      {
        name: "consumer",
        ...(nats && config.stream && config.consumer
          ? { run: consumerCheck(nats, config.stream, config.consumer, "steele-collector-probe") }
          : {}),
      },
      {
        name: "archive",
        ...(config.archive
          ? {
              run: async () => {
                // Read-only: no initialise(), so a missing repository is not created.
                const store = new GitArtifactStore({
                  repoPath: config.archive!.path,
                  repository: config.archive!.repository,
                });
                await store.list("substack", 1);
              },
            }
          : {}),
      },
      {
        name: "state",
        ...(config.statePath
          ? {
              run: async (signal) => {
                await stateProbeFor(config.statePath!, config.stateOptions).readCounts(signal);
              },
            }
          : {}),
      },
    ],
    config.timeoutMs,
  );
}
