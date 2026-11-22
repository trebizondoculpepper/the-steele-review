import type { ElasticsearchConnection } from "../config/credentials.js";
import { fileCheckpoint } from "../collection/catchup-checkpoint.js";
import { GitArtifactStore } from "../controllers/artifact-store.js";
import { ElasticsearchController } from "../controllers/elasticsearch.js";
import { runRoleProbe, type RoleProbeReport } from "./role-probe.js";
import { stateProbeFor, type StateProbeOptions } from "./runtime-status.js";
import { DEFAULT_CHECK_TIMEOUT_MS } from "./runtime-status.js";

/**
 * Git-triggered captured-post indexer readiness (#326):
 * - `archive`: the capture archive is a readable Git repository;
 * - `trigger`: the durable catch-up checkpoint every pass starts from is
 *   readable and names an indexed revision;
 * - `search`: the logical full-text index answers a one-document read;
 * - `state`: the operation store holding the pass lease opens read-only.
 *
 * Reconciliation progress (the checkpoint and how many archive changes it
 * has not reached yet) is reported in `details`, separately: a backlog is
 * not a readiness failure. Read-only: no pass, lease, write or repair.
 */
export interface CapturedIndexProbeConfig {
  archive?: { path: string; repository: string };
  checkpointPath?: string;
  elasticsearch?: ElasticsearchConnection;
  index?: string;
  statePath?: string;
  stateOptions?: StateProbeOptions;
  timeoutMs?: number;
}

export async function probeCapturedIndex(
  config: CapturedIndexProbeConfig,
): Promise<RoleProbeReport> {
  const archive = config.archive
    ? new GitArtifactStore({ repoPath: config.archive.path, repository: config.archive.repository })
    : undefined;
  let checkpoint: { commit?: string; pending?: string } | undefined;
  let checkpointRead = false;
  if (config.checkpointPath) {
    try {
      checkpoint = await fileCheckpoint(config.checkpointPath).load();
      checkpointRead = true;
    } catch {
      checkpointRead = false;
    }
  }
  const commit =
    typeof checkpoint?.commit === "string" && /^[0-9a-f]{40,64}$/.test(checkpoint.commit)
      ? checkpoint.commit
      : undefined;
  const details: Record<string, string | number> = {};
  if (commit) details.checkpoint = commit.slice(0, 12);
  if (checkpoint?.pending !== undefined) details.passInProgress = 1;
  // Progress only: how far the index is behind the archive head.
  if (archive && commit) {
    const timeout = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
    try {
      const behind = await Promise.race([
        archive.changesSince(commit),
        new Promise<never>((_, reject) =>
          timeout.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
        ),
      ]);
      if (!behind.full) details.unindexedChanges = behind.changes.length;
    } catch {
      // Progress is best effort; readiness is decided by the checks below.
    }
  }
  const es = config.elasticsearch;
  return runRoleProbe(
    "captured-index-worker",
    [
      {
        name: "archive",
        ...(archive ? { run: async () => void (await archive.list("substack", 1)) } : {}),
      },
      {
        name: "trigger",
        ...(config.checkpointPath
          ? {
              run: async () => {
                if (!checkpointRead || !commit) throw new Error("no usable checkpoint");
              },
            }
          : {}),
      },
      {
        name: "search",
        ...(es && config.index
          ? {
              run: async () => {
                const controller = new ElasticsearchController(es.url, es.apiKey);
                try {
                  await controller.search(config.index!, { match_all: {} }, { size: 1 });
                } finally {
                  await controller.close().catch(() => undefined);
                }
              },
            }
          : {}),
      },
      {
        name: "state",
        ...(config.statePath
          ? {
              run: async (signal) =>
                void (await stateProbeFor(config.statePath!, config.stateOptions).readCounts(
                  signal,
                )),
            }
          : {}),
      },
    ],
    config.timeoutMs,
    details,
  );
}
