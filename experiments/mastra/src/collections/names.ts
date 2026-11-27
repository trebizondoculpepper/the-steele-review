/**
 * Elasticsearch names for collections (#942).
 *
 * A collection keeps its on-disk directory name. Its Elasticsearch names are
 * derived from it under a deployment namespace (default `steele-review`):
 *
 *   alias          <namespace>-<name>            e.g. steele-review-raw-content
 *   backing index  <alias>-v<mapping version>    e.g. steele-review-raw-content-v1
 *   rebuilt index  <alias>-v<version>-r<n>       a rebuild at the same mapping version
 *
 * <name> is the directory name lower-cased, with any run of characters
 * Elasticsearch does not allow replaced by `-`. Names are validated before any
 * index is touched, and two directories that normalise to the same name are
 * both rejected rather than sharing an index.
 */

export const DEFAULT_NAMESPACE = "steele-review";

/** Room left after the alias for `-v<version>-r<n>`. */
const SUFFIX_ROOM = 32;
const MAX_INDEX_BYTES = 255;
const NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function validateNamespace(namespace: string): string {
  if (!NAME.test(namespace) || namespace.includes("..") || Buffer.byteLength(namespace) > 100)
    throw new Error("the index namespace must be lower-case letters, digits, '.', '_' or '-', starting with a letter or digit");
  return namespace;
}

/** The normalised collection name, or undefined when nothing usable remains. */
export function normaliseCollectionName(directory: string): string | undefined {
  const name = directory
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "");
  return NAME.test(name) ? name : undefined;
}

export interface CollectionName {
  /** The directory name in the repository, unchanged. */
  directory: string;
  name: string;
  alias: string;
}

export interface NameRejection {
  directory: string;
  reason: "invalid-name" | "name-collision" | "name-too-long" | "reserved-suffix";
}

/**
 * Backing indexes end in `-v<n>` or `-v<n>-r<n>`. A collection name with that
 * ending could make its alias equal another collection's backing index
 * (`feeds-v1` against `feeds` at version 1), and Elasticsearch indexes and
 * aliases share one namespace, so such names are rejected.
 */
const RESERVED_SUFFIX = /-v[0-9]+(-r[0-9]+)?$/;

/** Name every discovered directory, rejecting invalid names and collisions. */
export function nameCollections(
  namespace: string,
  directories: readonly string[],
): { collections: CollectionName[]; rejected: NameRejection[] } {
  const rejected: NameRejection[] = [];
  const byName = new Map<string, string[]>();
  for (const directory of directories) {
    // Hidden directories (".git", ".github", ...) are never collections.
    if (directory.startsWith(".")) continue;
    // The directory name is a checkpoint key, so it must start with a letter or
    // digit: this also excludes "__proto__", which a plain object would not keep.
    if (!/^[A-Za-z0-9]/.test(directory)) {
      rejected.push({ directory, reason: "invalid-name" });
      continue;
    }
    const name = normaliseCollectionName(directory);
    if (!name) {
      rejected.push({ directory, reason: "invalid-name" });
      continue;
    }
    if (RESERVED_SUFFIX.test(name)) {
      rejected.push({ directory, reason: "reserved-suffix" });
      continue;
    }
    if (Buffer.byteLength(`${namespace}-${name}`) > MAX_INDEX_BYTES - SUFFIX_ROOM) {
      rejected.push({ directory, reason: "name-too-long" });
      continue;
    }
    byName.set(name, [...(byName.get(name) ?? []), directory]);
  }
  const collections: CollectionName[] = [];
  for (const [name, dirs] of byName) {
    if (dirs.length > 1) for (const directory of dirs) rejected.push({ directory, reason: "name-collision" });
    else collections.push({ directory: dirs[0]!, name, alias: `${namespace}-${name}` });
  }
  collections.sort((a, b) => a.name.localeCompare(b.name));
  return { collections, rejected };
}

export function backingIndexName(alias: string, mappingVersion: number, rebuild = 0): string {
  return rebuild > 0 ? `${alias}-v${mappingVersion}-r${rebuild}` : `${alias}-v${mappingVersion}`;
}

/** Elasticsearch `_id` is at most 512 bytes; longer paths use a hash. */
export function documentId(relativePath: string, hash: (s: string) => string): string {
  return Buffer.byteLength(relativePath) <= 512 ? relativePath : `sha256:${hash(relativePath)}`;
}
