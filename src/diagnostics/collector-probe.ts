import type { NatsConnection } from "../config/credentials.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { NatsController } from "../controllers/nats.js";
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
      {
        name: "broker",
        ...(nats
          ? { run: (signal) => new NatsController(nats.url, nats.token).check(signal) }
          : {}),
      },
      {
        name: "consumer",
        ...(nats && config.stream && config.consumer
          ? {
              run: async (signal) => {
                const controller = new NatsController(nats.url, nats.token);
                const close = () => void controller.close().catch(() => undefined);
                signal.addEventListener("abort", close, { once: true });
                try {
                  await controller.connect("steele-collector-probe");
                  // Reads consumer info only; a missing consumer fails here.
                  await controller.consumerPosition(config.stream!, config.consumer!);
                } finally {
                  signal.removeEventListener("abort", close);
                  await controller.close().catch(() => undefined);
                }
              },
            }
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
