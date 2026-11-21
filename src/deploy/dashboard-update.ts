/**
 * Dashboard-only automatic update after a successful main image build (#476).
 *
 * Pull-based: a private scheduler runs this on the deployment host, so no
 * management endpoint or webhook is exposed. One pass reads the newest
 * trusted build (a successful `push` to `main`), resolves its commit-tagged
 * image to an immutable digest and, only when that commit is strictly newer
 * than the recorded deployment, replaces the dashboard image and nothing
 * else. Readiness is checked afterwards; a failed check rolls back to the
 * previous image and records the failed commit so it is never retried in a
 * loop. Older, duplicate, failed and out-of-order builds never redeploy.
 *
 * Every external system sits behind a narrow port; the CLI wires private
 * adapters (see src/controllers/dashboard-deploy.ts). Nothing here knows
 * addresses, stack identities or credentials.
 */

export interface Build {
  runId: number;
  commit: string;
  conclusion: string;
  branch: string;
  event: string;
}

export interface BuildsPort {
  /** The newest completed run of the image workflow on main, if any. */
  latestMainBuild(): Promise<Build | undefined>;
  /** True when `newer` strictly descends from `older` on the repository. */
  isStrictlyNewer(older: string, newer: string): Promise<boolean>;
}

export interface RegistryPort {
  /** Immutable digest of the commit-tagged image, or undefined when absent. */
  digestFor(commit: string): Promise<string | undefined>;
}

export interface DashboardStackPort {
  /** The dashboard image reference currently configured. */
  currentImage(): Promise<string | undefined>;
  /** Make the image present on the host, so the update never pulls anything else. */
  pull(image: string): Promise<void>;
  /** Recreate only the dashboard with this image; every other setting is preserved. */
  setImage(image: string): Promise<void>;
}

export interface ReadinessPort {
  /** True once the dashboard and its main pages answer within a bounded wait. */
  ready(): Promise<boolean>;
}

export interface DeployedRevision {
  commit: string;
  image: string;
  at: string;
}

export interface UpdateState {
  deployed?: DeployedRevision;
  /** The last commit whose image failed readiness; skipped until a newer build. */
  failed?: DeployedRevision;
}

export type UpdateOutcome =
  | { outcome: "skipped"; reason: SkipReason; commit?: string }
  | { outcome: "deployed"; commit: string; image: string }
  | { outcome: "rolled-back"; commit: string; image: string; restored: string }
  | { outcome: "rollback-failed"; commit: string; image: string; restored: string };

export type SkipReason =
  | "no-trusted-build"
  | "already-deployed"
  | "failed-previously"
  | "not-newer"
  | "baseline-unknown"
  | "drift"
  | "image-missing";

const COMMIT = /^[0-9a-f]{40}$/;

/** The image reference pinned by digest, from the commit-tagged repository. */
export const pinnedImage = (repository: string, digest: string) => `${repository}@${digest}`;

export async function updateDashboard(input: {
  imageRepository: string;
  state: UpdateState;
  builds: BuildsPort;
  registry: RegistryPort;
  stack: DashboardStackPort;
  readiness: ReadinessPort;
  now?: () => Date;
}): Promise<{ result: UpdateOutcome; state: UpdateState }> {
  const { state, builds, registry, stack, readiness } = input;
  const now = () => (input.now ?? (() => new Date()))().toISOString();
  const skip = (reason: SkipReason, commit?: string) => ({
    result: { outcome: "skipped" as const, reason, ...(commit ? { commit } : {}) },
    state,
  });

  const build = await builds.latestMainBuild();
  if (
    !build ||
    build.conclusion !== "success" ||
    build.branch !== "main" ||
    build.event !== "push" ||
    !COMMIT.test(build.commit)
  ) {
    return skip("no-trusted-build");
  }
  const commit = build.commit;
  if (!state.deployed) return skip("baseline-unknown", commit);
  if (state.deployed.commit === commit) return skip("already-deployed", commit);
  if (state.failed?.commit === commit) return skip("failed-previously", commit);

  // Someone changed the dashboard by hand: never overwrite it silently.
  const live = await stack.currentImage();
  if (live !== state.deployed.image) return skip("drift", commit);

  if (!(await builds.isStrictlyNewer(state.deployed.commit, commit))) {
    return skip("not-newer", commit);
  }
  const digest = await registry.digestFor(commit);
  if (!digest) return skip("image-missing", commit);
  const image = pinnedImage(input.imageRepository, digest);

  await stack.pull(image);
  await stack.setImage(image);
  if (await readiness.ready()) {
    return {
      result: { outcome: "deployed", commit, image },
      state: { deployed: { commit, image, at: now() } },
    };
  }

  // Bounded recovery: one rollback to the image that was serving before.
  const restored = state.deployed.image;
  const failed = { commit, image, at: now() };
  let back = false;
  try {
    await stack.setImage(restored);
    back = await readiness.ready();
  } catch {
    back = false;
  }
  return {
    result: { outcome: back ? "rolled-back" : "rollback-failed", commit, image, restored },
    state: { deployed: state.deployed, failed },
  };
}
