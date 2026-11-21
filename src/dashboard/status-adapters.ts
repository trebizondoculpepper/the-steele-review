import type {
  CatchUpCheckpointState,
  CatchUpCheckpointStore,
} from "../collection/index-catchup.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { collectRuntimeStatus, type RuntimeStatusDependencies } from "../diagnostics/runtime-status.js";
import { readDiscoveryStatus } from "../discovery/status.js";
import { DEFAULT_STALE_AFTER_MS, type StatusSource, type StatusSnapshot } from "./status.js";

/**
 * Adapters from existing controllers to the status page (#376). Composition
 * only: the same read-only probes the `status` command uses, the archive's
 * bounded listing and change comparison, and the discovery runner's status
 * file. Nothing here writes, provisions or calls a model.
 */

/** Bound on the archive listing; a larger archive is reported truncated. */
export const ARCHIVE_SCAN_LIMIT = 2_000;

const CAPTURE = /^substack\/[a-z0-9][a-z0-9-]*\/[^/]+\/collected\.json$/;

export interface StatusAdapterDeps {
  runtime: RuntimeStatusDependencies;
  archive?: Pick<GitArtifactStore, "list" | "changesSince">;
  checkpoint?: CatchUpCheckpointStore;
  /** Path of the discovery runner's status file; absent when not configured. */
  discoveryStatusPath?: string;
  now?: () => Date;
  staleAfterMs?: number;
  timeoutMs?: number;
}

export function systemStatusSource(deps: StatusAdapterDeps): StatusSource {
  const now = deps.now ?? (() => new Date());
  return {
    async read(): Promise<StatusSnapshot> {
      const observed = now();
      const report = await collectRuntimeStatus(deps.runtime, {
        now: () => observed,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      });
      const services = report.checks.map((check) => ({
        name: check.name,
        state: check.status as StatusSnapshot["services"][number]["state"],
      }));
      const stateCheck = report.checks.find((check) => check.name === "state");
      const operations =
        stateCheck?.name === "state" && stateCheck.status === "healthy" ? stateCheck.counts : [];

      const feedPoll = await feedPollFor(deps, observed);
      const archive = await archiveProgress(deps);
      const indexCatchUp = await indexCatchUpFor(deps);

      return {
        observedAt: observed.toISOString(),
        services,
        operations,
        feedPoll,
        archive,
        indexCatchUp,
      };
    },
  };
}

async function feedPollFor(
  deps: StatusAdapterDeps,
  observed: Date,
): Promise<StatusSnapshot["feedPoll"]> {
  if (!deps.discoveryStatusPath) return { state: "not-configured" };
  const status = await readDiscoveryStatus(deps.discoveryStatusPath);
  if (!status) return { state: "unavailable" };
  // Only a completed poll counts; lifecycle updates refresh `at` but not this.
  const at = status.lastPollAt ?? (status.runs > 0 ? status.at : undefined);
  if (at === undefined) return { state: "no-poll-yet" };
  const age = observed.getTime() - Date.parse(at);
  const staleAfter = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  return { state: Number.isFinite(age) && age <= staleAfter ? "current" : "stale", at };
}

async function archiveProgress(deps: StatusAdapterDeps): Promise<StatusSnapshot["archive"]> {
  if (!deps.archive) return { state: "not-configured" };
  try {
    const paths = await deps.archive.list("substack", ARCHIVE_SCAN_LIMIT);
    const captured = paths.filter((path) => CAPTURE.test(path)).length;
    return { state: "ok", captured, truncated: paths.length >= ARCHIVE_SCAN_LIMIT };
  } catch {
    return { state: "unavailable" };
  }
}

/**
 * True when the checkpoint proves whole-archive coverage. A filtered replay or
 * a publication-scoped pass (`wholePublication: false`, or a recorded
 * publication) only covered part of the archive, so it cannot make the index
 * "current".
 */
const coversWholeArchive = (state: CatchUpCheckpointState): boolean =>
  state.wholePublication !== false && typeof state.publicationId !== "string";

async function indexCatchUpFor(deps: StatusAdapterDeps): Promise<StatusSnapshot["indexCatchUp"]> {
  if (!deps.archive || !deps.checkpoint) return { state: "not-configured" };
  try {
    const state = await deps.checkpoint.load();
    if (!state?.commit) return { state: "pending" };
    if (!coversWholeArchive(state)) return { state: "incomplete" };
    const since = await deps.archive.changesSince(state.commit);
    if (!since.head) return { state: "unavailable" };
    if (since.head === state.commit) return { state: "current" };
    return { state: "behind", pendingChanges: since.changes.length };
  } catch {
    return { state: "unavailable" };
  }
}
