import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * A cross-process lock for indexing passes (#952).
 *
 * One pass at a time may load the checkpoint, change indexes and save the
 * checkpoint, whether it was started by the Git hook, a manual recovery or a
 * schedule. The lock is a directory (created atomically) holding the owner's
 * PID. A lock whose owner is no longer running, or that is older than
 * `staleMs`, is taken over, so a crashed pass cannot block indexing forever.
 */

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
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withLock<T>(path: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const waitMs = options.waitMs ?? 15 * 60_000;
  const staleMs = options.staleMs ?? 60 * 60_000;
  const pollMs = options.pollMs ?? 200;
  const deadline = Date.now() + waitMs;
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      await mkdir(path, { recursive: false });
      await writeFile(join(path, "owner"), `${process.pid}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await abandoned(path, staleMs)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError();
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return await work();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

async function abandoned(path: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > staleMs) return true;
    const pid = Number((await readFile(join(path, "owner"), "utf8")).trim());
    // A lock without an owner yet is being created; give it a moment.
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - info.mtimeMs > 5_000;
    return !alive(pid);
  } catch (error) {
    // Removed meanwhile: not abandoned, just retry.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}
