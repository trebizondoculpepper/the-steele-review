import { execFile } from "node:child_process";

/**
 * Browsable working copies of the artifact repositories (#420).
 *
 * The artifact store (artifact-store.ts) owns all writes and history. Owners
 * also keep normal clones of the archive and processed-content repositories
 * to browse; this controller keeps such a clone up to date, and is the only
 * place that does. It fast-forwards a clone to its origin's branch head and
 * nothing else:
 *
 * - only when the clone has no tracked, untracked or ignored-but-incoming
 *   local changes would be lost: a dirty tree, a detached HEAD or a diverged
 *   branch is left exactly as it is and reported;
 * - never reset, clean, stash, rebase or overwrite ignored files;
 * - every Git call is bounded by a timeout, so a stalled fetch cannot hold
 *   the refresh lock indefinitely;
 * - Git's own diagnostics are never surfaced (they can contain private
 *   paths): results carry a fixed reason category and a revision only.
 */

export type RefreshReason =
  | "not-a-checkout"
  | "local-changes"
  | "detached-head"
  | "fetch-failed"
  | "diverged"
  | "fast-forward-failed";

export type RefreshOutcome =
  | { state: "fresh"; revision: string; updated: boolean }
  | { state: "stale"; reason: RefreshReason; revision?: string };

export interface WorkingCopyOptions {
  /** Per Git call. Default 120 s. */
  timeoutMs?: number;
  gitBinary?: string;
}

class GitFailed extends Error {}

export async function refreshWorkingCopy(
  checkout: string,
  options: WorkingCopyOptions = {},
): Promise<RefreshOutcome> {
  const timeout = options.timeoutMs ?? 120_000;
  const git = (...args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        options.gitBinary ?? "git",
        ["-C", checkout, ...args],
        {
          timeout,
          killSignal: "SIGKILL",
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
        // Diagnostics are dropped on purpose; callers get categories only.
        (error, stdout) => (error ? reject(new GitFailed()) : resolve(stdout.trim())),
      );
    });
  const attempt = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };

  const head = await attempt(() => git("rev-parse", "--verify", "-q", "HEAD"));
  if (!head) return { state: "stale", reason: "not-a-checkout" };
  const changes = await attempt(() => git("status", "--porcelain", "--untracked-files=all"));
  if (changes === undefined) return { state: "stale", reason: "not-a-checkout", revision: head };
  if (changes) return { state: "stale", reason: "local-changes", revision: head };
  const branch = await attempt(() => git("symbolic-ref", "--quiet", "--short", "HEAD"));
  if (!branch) return { state: "stale", reason: "detached-head", revision: head };
  if ((await attempt(() => git("fetch", "--quiet", "origin", branch))) === undefined) {
    return { state: "stale", reason: "fetch-failed", revision: head };
  }
  const remote = await attempt(() => git("rev-parse", "--verify", "-q", "FETCH_HEAD"));
  if (!remote) return { state: "stale", reason: "fetch-failed", revision: head };
  if (remote === head) return { state: "fresh", revision: head, updated: false };
  if ((await attempt(() => git("merge-base", "--is-ancestor", head, remote))) === undefined) {
    return { state: "stale", reason: "diverged", revision: head };
  }
  // --no-overwrite-ignore: an ignored local file that upstream starts tracking
  // is never silently replaced; the update fails and is reported instead.
  const merged = await attempt(() =>
    git("merge", "--ff-only", "--no-overwrite-ignore", "--quiet", remote),
  );
  if (merged === undefined)
    return { state: "stale", reason: "fast-forward-failed", revision: head };
  return { state: "fresh", revision: remote, updated: true };
}
