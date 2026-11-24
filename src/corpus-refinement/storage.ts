import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Keep the Corpus Refinement experiment store apart from the live repositories
 * (#847). The experiment writes its own artifacts; it must never initialise or
 * write inside the archive or content repositories, nor contain them.
 *
 * Paths are compared after resolving symbolic links, so an alias of a live
 * repository is caught too. A path that does not exist yet is resolved through
 * its nearest existing ancestor.
 */

export class CorpusStorageConflictError extends Error {
  constructor(
    readonly store: string,
    readonly live: string,
  ) {
    super(`Corpus Refinement store ${store} overlaps the live repository ${live}`);
    this.name = "CorpusStorageConflictError";
  }
}

/** Resolve symbolic links, walking up to the nearest existing ancestor. */
function canonical(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length ? resolve(real, ...missing.reverse()) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** True when either path is the other or lies inside it. */
function overlaps(a: string, b: string): boolean {
  const inside = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}

/**
 * Return the canonical store path, or throw when it resolves to, contains or
 * lies inside any configured live repository. Unset live paths are ignored.
 */
export function assertIsolatedStore(store: string, live: (string | undefined)[]): string {
  const storeReal = canonical(store);
  for (const path of live) {
    if (!path) continue;
    if (overlaps(storeReal, canonical(path))) {
      throw new CorpusStorageConflictError(store, path);
    }
  }
  return storeReal;
}
