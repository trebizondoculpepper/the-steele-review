import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Keep the Corpus Refinement experiment store apart from the live repositories
 * (#847). The experiment writes its own artifacts; it must never initialise or
 * write inside the archive or content repositories, nor contain them.
 *
 * Paths are resolved the way the kernel resolves them: symbolic links are
 * followed before any `..` is applied, so an alias of a live repository is
 * caught. Existing directories are compared by filesystem identity (device and
 * inode), so two spellings of one directory on a case-insensitive volume are
 * the same directory. A store path that does not exist yet is resolved through
 * its nearest existing ancestor.
 *
 * Error messages name configuration variables only, never their values.
 */

export interface NamedPath {
  /** The configuration variable the path came from, safe to log. */
  name: string;
  path: string | undefined;
}

export class CorpusStorageConflictError extends Error {
  constructor(
    readonly store: string,
    readonly live: string,
    readonly reason: "overlap" | "unsafe-path" | "unresolvable",
    /** For an unresolvable path: the filesystem error code only, such as ENOTDIR. */
    readonly code?: string,
  ) {
    super(
      reason === "overlap"
        ? `Corpus Refinement store (${store}) overlaps the live repository (${live})`
        : reason === "unsafe-path"
          ? `Corpus Refinement path (${live}) has '..' after a missing directory`
          : `Corpus Refinement path (${live}) could not be resolved (${code})`,
    );
    this.name = "CorpusStorageConflictError";
  }
}

interface Resolved {
  /** Canonical path of the deepest existing directory. */
  existing: string;
  /** Path components below it that do not exist yet. */
  tail: string[];
  /** Full canonical spelling: existing plus tail. */
  full: string;
}

/**
 * A filesystem error names the configured path in its message; report only
 * the variable name and a bounded error code instead.
 */
function unresolvable(name: string, error: unknown): CorpusStorageConflictError {
  const code = (error as NodeJS.ErrnoException)?.code;
  const safe = typeof code === "string" && /^E[A-Z]{2,15}$/.test(code) ? code : "EUNKNOWN";
  return new CorpusStorageConflictError(name, name, "unresolvable", safe);
}

/**
 * Resolve as the kernel does: hand the unnormalised spelling to the native
 * realpath (Node's default realpathSync normalises `..` first), so
 * a symbolic link is followed before a `..` after it. Only components that do
 * not exist are peeled off, and a missing component may not be `.` or `..`.
 */
function canonical(entry: NamedPath & { path: string }): Resolved {
  const spelled = isAbsolute(entry.path) ? entry.path : `${process.cwd()}${sep}${entry.path}`;
  const parts = spelled.split(sep);
  const tail: string[] = [];
  while (parts.length) {
    const candidate = parts.join(sep) || sep;
    try {
      const existing = realpathSync.native(candidate);
      return { existing, tail, full: tail.length ? resolve(existing, ...tail) : existing };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unresolvable(entry.name, error);
      const missing = parts.pop()!;
      if (missing === ".." || missing === ".")
        throw new CorpusStorageConflictError(entry.name, entry.name, "unsafe-path");
      if (missing) tail.unshift(missing);
    }
  }
  const root = realpathSync.native(sep);
  return { existing: root, tail, full: resolve(root, ...tail) };
}

const identity = (path: string) => {
  const s = statSync(path);
  return `${s.dev}:${s.ino}`;
};

/** Identities of a directory and every ancestor up to the root. */
function lineage(path: string): Set<string> {
  const ids = new Set<string>();
  for (let current = path; ; current = dirname(current)) {
    ids.add(identity(current));
    if (dirname(current) === current) return ids;
  }
}

/** True when either path is the other or lies inside it, by spelling. */
function nested(a: string, b: string): boolean {
  const inside = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}

/** True when the store is, contains or lies inside the live path. */
function overlaps(store: Resolved, live: Resolved): boolean {
  if (nested(store.full, live.full)) return true;
  // Identity checks cover spellings that differ only in case on a
  // case-insensitive volume.
  if (!live.tail.length && lineage(store.existing).has(identity(live.existing))) return true;
  if (!store.tail.length && lineage(live.existing).has(identity(store.existing))) return true;
  return false;
}

/**
 * Return the canonical store path, or throw when it resolves to, contains or
 * lies inside any configured live repository. Unset live paths are ignored.
 */
export function assertIsolatedStore(
  store: NamedPath & { path: string },
  live: NamedPath[],
): string {
  const storeResolved = canonical(store);
  for (const entry of live) {
    if (!entry.path) continue;
    const liveResolved = canonical({ name: entry.name, path: entry.path });
    let overlap: boolean;
    try {
      overlap = overlaps(storeResolved, liveResolved);
    } catch (error) {
      throw unresolvable(entry.name, error);
    }
    if (overlap) throw new CorpusStorageConflictError(store.name, entry.name, "overlap");
  }
  return storeResolved.full;
}
