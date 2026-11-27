import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { GitError, type GitRepository } from "../common/git/index.js";

/**
 * A cross-process lock for indexing passes (#952), held in the collections
 * repository itself.
 *
 * One pass at a time may load the checkpoint, change indexes and save the
 * checkpoint, whether it was started by the Git hook, a manual recovery or a
 * schedule. The lock is a ref pointing at a blob that names its owner (host,
 * PID, a random token and the time it was taken). Every transition is one
 * atomic compare-and-swap ref update, so:
 *
 * - taking it creates the ref only if it does not exist;
 * - taking over an abandoned lock (its owner on this host has exited, or it is
 *   older than `staleMs`) moves the ref only if it still names that abandoned
 *   owner, so when several contenders find it abandoned exactly one wins;
 * - releasing deletes the ref only if it still names this owner, so a pass can
 *   never remove a lock someone else holds;
 * - the owner record is written before the ref exists, so there is never a
 *   lock without an owner.
 *
 * The ref is outside refs/heads, so the indexing hook ignores it.
 */

export const LOCK_REF = "refs/steele-collections/index-lock";

export class LockTimeoutError extends Error {
  constructor() {
    super("another indexing pass is still running");
    this.name = "LockTimeoutError";
  }
}

export interface LockOptions {
  /** How long to wait for the lock; default 15 minutes. */
  waitMs?: number;
  /** Age after which a lock is considered abandoned; default 1 hour. */
  staleMs?: number;
  pollMs?: number;
  /** For tests: the clock and process checks. */
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  host?: string;
}

interface Owner {
  host: string;
  pid: number;
  token: string;
  at: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withLock<T>(repo: GitRepository, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processAlive;
  const host = options.host ?? hostname();
  const staleMs = options.staleMs ?? 60 * 60_000;
  const pollMs = options.pollMs ?? 200;
  const deadline = now() + (options.waitMs ?? 15 * 60_000);
  const owner: Owner = { host, pid: process.pid, token: randomUUID(), at: now() };
  const mine = await repo.writeBlob(JSON.stringify(owner));

  const abandoned = async (current: string): Promise<boolean> => {
    let held: Owner;
    try {
      held = JSON.parse((await repo.readBlob(current)) ?? "null") as Owner;
    } catch {
      return true; // an unreadable owner record can never be released by its owner
    }
    if (!held || typeof held.at !== "number") return true;
    if (now() - held.at > staleMs) return true;
    return held.host === host && !isAlive(held.pid);
  };

  for (;;) {
    try {
      await repo.swapRef(LOCK_REF, mine, null);
      break;
    } catch (error) {
      if (!(error instanceof GitError && error.code === "conflict")) throw error;
    }
    const current = await repo.readRef(LOCK_REF);
    if (current && (await abandoned(current))) {
      try {
        // Only one contender can move the ref away from this exact owner.
        await repo.swapRef(LOCK_REF, mine, current);
        break;
      } catch (error) {
        if (!(error instanceof GitError && error.code === "conflict")) throw error;
      }
      continue;
    }
    if (now() >= deadline) throw new LockTimeoutError();
    await new Promise((r) => setTimeout(r, pollMs));
  }
  try {
    return await work();
  } finally {
    // Deletes the lock only if it is still ours.
    await repo.swapRef(LOCK_REF, null, mine).catch(() => undefined);
  }
}
