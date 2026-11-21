/**
 * Keep browsable content checkouts fresh without overwriting local edits (#420).
 *
 *   refresh-content-views <status-dir> <name>=<checkout> [<name>=<checkout> ...]
 *
 * Fast-forwards each named working copy through the working-copy controller
 * (src/controllers/working-copy.ts) and writes one status file per view,
 * <status-dir>/<name>.json:
 *   {"view","state":"fresh"|"stale","reason"?,"revision"?,"checkedAt","lastSuccessAt"?}
 * holding no paths, URLs or file names. A stale view also logs one
 * sanitised JSON line. Run it from a scheduler at a bounded interval; the
 * host paths and schedule are private deployment configuration.
 *
 * Serialised by an owner-aware lock (<status-dir>/.refresh.lock records host
 * and process ID). A run that finds a live owner exits without doing
 * anything; a lock is taken over only when its owner process is provably gone
 * on this host, never because of its age. Git calls are bounded by timeouts,
 * so a live owner always finishes.
 *
 * Exit: 0 done or another refresh is running; 1 the status directory or lock
 * could not be used; 2 invalid usage. Diagnostics are fixed categories only.
 */
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { refreshWorkingCopy, type RefreshOutcome } from "../controllers/working-copy.js";

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const fail = (category: string, code: number) => {
  console.error(JSON.stringify({ event: "content-view-refresh", outcome: category }));
  return code;
};

/** True when `pid` is a live process on this host. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take the lock, or report that a live owner holds it. */
async function acquire(lock: string): Promise<"acquired" | "busy" | "error"> {
  const me = JSON.stringify({ host: hostname(), pid: process.pid });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(me);
      await handle.close();
      return "acquired";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "error";
    }
    let owner: { host?: unknown; pid?: unknown } = {};
    try {
      owner = JSON.parse(await readFile(lock, "utf8")) as typeof owner;
    } catch {
      return "busy"; // being written right now, or unreadable: never steal it
    }
    // Another host's lock, or a live owner here: never take it over.
    if (owner.host !== hostname() || typeof owner.pid !== "number" || alive(owner.pid)) {
      return "busy";
    }
    await rm(lock, { force: true }).catch(() => undefined); // owner is gone
  }
  return "busy";
}

/** Remove the lock only while it is still ours. */
async function release(lock: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(lock, "utf8")) as { host?: unknown; pid?: unknown };
    if (owner.host === hostname() && owner.pid === process.pid) await rm(lock, { force: true });
  } catch {
    // nothing to release
  }
}

async function writeStatus(statusDir: string, view: string, outcome: RefreshOutcome) {
  const file = join(statusDir, `${view}.json`);
  const now = new Date().toISOString();
  let lastSuccessAt: string | undefined = outcome.state === "fresh" ? now : undefined;
  if (!lastSuccessAt) {
    try {
      const previous = JSON.parse(await readFile(file, "utf8")) as { lastSuccessAt?: unknown };
      if (typeof previous.lastSuccessAt === "string") lastSuccessAt = previous.lastSuccessAt;
    } catch {
      // no earlier status
    }
  }
  const status = {
    view,
    state: outcome.state,
    ...(outcome.state === "stale" ? { reason: outcome.reason } : {}),
    ...(outcome.revision ? { revision: outcome.revision } : {}),
    checkedAt: now,
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
  };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status)}\n`);
  await rename(temporary, file);
}

async function main(argv: string[]): Promise<number> {
  const [statusDir, ...pairs] = argv;
  const views = pairs.map((p) => {
    const i = p.indexOf("=");
    return { name: p.slice(0, i), checkout: p.slice(i + 1) };
  });
  if (!statusDir || views.length === 0 || views.some((v) => !NAME.test(v.name) || !v.checkout)) {
    console.error("Usage: refresh-content-views <status-dir> <name>=<checkout>...");
    return 2;
  }
  try {
    await mkdir(statusDir, { recursive: true });
  } catch {
    return fail("status-dir-unavailable", 1);
  }
  const lock = join(statusDir, ".refresh.lock");
  const held = await acquire(lock);
  if (held === "busy") return 0;
  if (held === "error") return fail("lock-unavailable", 1);
  try {
    for (const { name, checkout } of views) {
      const outcome = await refreshWorkingCopy(checkout);
      try {
        await writeStatus(statusDir, name, outcome);
      } catch {
        return fail("status-write-failed", 1);
      }
      if (outcome.state === "stale") {
        console.error(
          JSON.stringify({
            event: "content-view-refresh",
            view: name,
            state: "stale",
            reason: outcome.reason,
          }),
        );
      }
    }
    return 0;
  } finally {
    await release(lock);
  }
}

process.exitCode = await main(process.argv.slice(2));
