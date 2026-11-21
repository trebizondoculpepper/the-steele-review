/**
 * Dashboard-only automatic update after a successful main image build (#476).
 *
 *   update-dashboard               one bounded pass; run it from a private scheduler
 *   update-dashboard --adopt <sha> record the dashboard's current image as built from <sha>
 *
 * Configuration (private deployment values; never printed):
 *   STEELE_DEPLOY_STATE_DIR        writable directory for state.json and the lock
 *   STEELE_DEPLOY_REPOSITORY       owner/name of the source repository and image
 *   STEELE_DEPLOY_WORKFLOW         image workflow file (default container-image.yml)
 *   STEELE_DEPLOY_PORTAINER_URL    Portainer API base URL (private network only)
 *   STEELE_DEPLOY_PORTAINER_KEY_FILE  file holding the Portainer API key
 *   STEELE_DEPLOY_STACK_ID         stack holding the dashboard
 *   STEELE_DEPLOY_IMAGE_VARIABLE   stack variable naming the dashboard image
 *   STEELE_DEPLOY_DASHBOARD_URL    dashboard base URL for readiness checks
 *   STEELE_DEPLOY_GITHUB_TOKEN_FILE   optional read-only token file (rate limits)
 *
 * Output is one JSON line with fixed fields. Exit: 0 deployed, skipped or
 * another pass is running; 1 rolled back, rollback failed or an adapter
 * failed (the previous image stays recorded); 2 invalid usage or configuration.
 */
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  DeployAdapterError,
  ghcrRegistry,
  githubBuilds,
  httpReadiness,
  portainerDashboardStack,
} from "../controllers/dashboard-deploy.js";
import { updateDashboard, type UpdateState } from "../deploy/dashboard-update.js";

const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event: "dashboard-update", ...fields }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * An exclusive lock. A dead owner's lock on this host is reclaimed only by
 * the run holding the exclusive `.reclaim` marker, and only if the lock file
 * still names that same dead owner, so a replacement owner's live lock is
 * never removed.
 */
async function lock(path: string): Promise<boolean> {
  const take = async () => {
    try {
      const h = await open(path, "wx");
      await h.writeFile(JSON.stringify({ host: hostname(), pid: process.pid }));
      await h.close();
      return true;
    } catch {
      return false;
    }
  };
  if (await take()) return true;
  let seen: string;
  try {
    seen = await readFile(path, "utf8");
    const owner = JSON.parse(seen) as { host?: string; pid?: number };
    if (owner.host !== hostname() || typeof owner.pid !== "number" || alive(owner.pid)) {
      return false;
    }
  } catch {
    return false;
  }
  const marker = `${path}.reclaim`;
  const claimMarker = async () => {
    try {
      const h = await open(marker, "wx");
      await h.writeFile(JSON.stringify({ host: hostname(), pid: process.pid }));
      await h.close();
      return true;
    } catch {
      return false;
    }
  };
  if (!(await claimMarker())) {
    // A marker left by a reclaimer that died is itself reclaimable, once.
    try {
      const raw = await readFile(marker, "utf8");
      const m = JSON.parse(raw) as { host?: string; pid?: number };
      if (m.host !== hostname() || typeof m.pid !== "number" || alive(m.pid)) return false;
      if ((await readFile(marker, "utf8")) !== raw) return false;
      await rm(marker, { force: true });
    } catch {
      return false;
    }
    if (!(await claimMarker())) return false;
  }
  try {
    // Re-read under the marker: remove only the dead owner we inspected.
    if ((await readFile(path, "utf8").catch(() => "")) !== seen) return false;
    await rm(path, { force: true });
    return await take();
  } finally {
    await rm(marker, { force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const env = process.env;
  const dir = env.STEELE_DEPLOY_STATE_DIR;
  const repository = env.STEELE_DEPLOY_REPOSITORY;
  if (!dir || !repository || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    log({ outcome: "invalid-configuration" });
    return 2;
  }
  const statePath = join(dir, "state.json");
  const readState = async (): Promise<UpdateState> => {
    try {
      return JSON.parse(await readFile(statePath, "utf8")) as UpdateState;
    } catch {
      return {};
    }
  };
  const writeState = async (state: UpdateState) => {
    await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2));
    await rename(`${statePath}.tmp`, statePath);
  };

  let stack;
  let keyFile = env.STEELE_DEPLOY_PORTAINER_KEY_FILE;
  try {
    if (!env.STEELE_DEPLOY_PORTAINER_URL || !keyFile || !env.STEELE_DEPLOY_STACK_ID) throw 0;
    const stackId = Number.parseInt(env.STEELE_DEPLOY_STACK_ID, 10);
    if (!Number.isInteger(stackId) || stackId < 1) throw 0;
    stack = portainerDashboardStack({
      url: env.STEELE_DEPLOY_PORTAINER_URL.replace(/\/$/, ""),
      apiKey: (await readFile(keyFile, "utf8")).trim(),
      stackId,
      imageVariable: env.STEELE_DEPLOY_IMAGE_VARIABLE ?? "STEELE_DASHBOARD_IMAGE",
    });
  } catch {
    log({ outcome: "invalid-configuration" });
    return 2;
  } finally {
    keyFile = undefined;
  }

  const lockPath = join(dir, ".update.lock");
  if (!(await lock(lockPath))) {
    log({ outcome: "skipped", reason: "already-running" });
    return 0;
  }
  try {
    if (argv[0] === "--adopt") {
      const commit = argv[1] ?? "";
      const image = await stack.currentImage();
      if (!/^[0-9a-f]{40}$/.test(commit) || !image || !image.includes("@sha256:")) {
        log({ outcome: "invalid-usage" });
        return 2;
      }
      const previous = await readState();
      // Adopting is an operator decision: it clears any pending update.
      const { pending: _pending, ...rest } = previous;
      await writeState({ ...rest, deployed: { commit, image, at: new Date().toISOString() } });
      log({ outcome: "adopted", commit, image });
      return 0;
    }
    if (argv.length > 0 || !env.STEELE_DEPLOY_DASHBOARD_URL) {
      log({ outcome: "invalid-usage" });
      return 2;
    }
    const token = env.STEELE_DEPLOY_GITHUB_TOKEN_FILE
      ? (await readFile(env.STEELE_DEPLOY_GITHUB_TOKEN_FILE, "utf8")).trim()
      : undefined;
    const state = await readState();
    const { result, state: next } = await updateDashboard({
      imageRepository: `ghcr.io/${repository.toLowerCase()}`,
      state,
      builds: githubBuilds({
        repository,
        workflowFile: env.STEELE_DEPLOY_WORKFLOW ?? "container-image.yml",
        ...(token ? { token } : {}),
      }),
      registry: ghcrRegistry({ repository: repository.toLowerCase() }),
      stack,
      readiness: httpReadiness({ baseUrl: env.STEELE_DEPLOY_DASHBOARD_URL.replace(/\/$/, "") }),
      save: writeState,
    });
    if (next !== state) await writeState(next);
    log({ ...result });
    return result.outcome === "deployed" || result.outcome === "skipped" ? 0 : 1;
  } catch (error) {
    log({
      outcome: "failed",
      reason: error instanceof DeployAdapterError ? error.category : "unexpected",
    });
    return 1;
  } finally {
    await rm(lockPath, { force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
