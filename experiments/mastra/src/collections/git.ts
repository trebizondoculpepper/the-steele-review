import { execFile } from "node:child_process";

/**
 * Read-only access to committed content in the collections repository (#942).
 *
 * The indexer reads only what is committed: a tree, a diff between two
 * commits, or a file at an exact revision. It never reads the working tree, so
 * uncommitted or half-written files are invisible to it. Every Git call uses
 * an argument array (no shell) and a timeout, and Git's own diagnostics are
 * never surfaced: they can contain private paths.
 */

export class GitReadError extends Error {
  constructor(readonly operation: string) {
    super(`git ${operation} failed`);
    this.name = "GitReadError";
  }
}

export interface TreeEntry {
  path: string;
  /** Git object ID of the file's content at that revision. */
  blob: string;
}

export interface PathChange {
  path: string;
  change: "upsert" | "delete";
}

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 256 * 1024 * 1024;

export class GitRepository {
  constructor(readonly root: string) {}

  private run(operation: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        // safe.directory: the repository is a mounted volume, usually owned by another user.
        ["-C", this.root, "-c", "core.quotepath=off", "-c", `safe.directory=${this.root}`, ...args],
        { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        (error, stdout) => (error ? reject(new GitReadError(operation)) : resolve(stdout)),
      );
    });
  }

  /** The commit the indexer can see, or undefined for a valid repository with no commits yet. */
  async head(): Promise<string | undefined> {
    // A missing, unreadable or broken repository is a technical failure, not an
    // empty one: this throws GitReadError, so a pass can never report success.
    await this.run("rev-parse", ["rev-parse", "--git-dir"]);
    try {
      return (await this.run("rev-parse", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).trim() || undefined;
    } catch {
      // `--verify --quiet` exits non-zero with no output when there is no HEAD yet.
      return undefined;
    }
  }

  /** Whether `ancestor` is reachable from `commit` (false for an unknown commit, e.g. after a history rewrite). */
  async isAncestor(ancestor: string, commit: string): Promise<boolean> {
    try {
      await this.run("merge-base", ["merge-base", "--is-ancestor", ancestor, commit]);
      return true;
    } catch {
      return false;
    }
  }

  /** Immediate child directories of the root at a revision. */
  async topLevelDirectories(revision: string): Promise<string[]> {
    const out = await this.run("ls-tree", ["ls-tree", "-z", "-d", "--full-tree", revision]);
    return out
      .split("\0")
      .filter(Boolean)
      .map((line) => line.slice(line.indexOf("\t") + 1));
  }

  /** Every file under a directory at a revision, with its blob ID. */
  async files(revision: string, directory: string): Promise<TreeEntry[]> {
    const out = await this.run("ls-tree", ["ls-tree", "-r", "-z", "--full-tree", revision, "--", `${directory}/`]);
    const entries: TreeEntry[] = [];
    for (const line of out.split("\0")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      const [, type, blob] = line.slice(0, tab).split(" ");
      if (type === "blob" && blob) entries.push({ path: line.slice(tab + 1), blob });
    }
    return entries;
  }

  /** Files changed between two commits, renames reported as a delete and an add. */
  async changes(from: string, to: string): Promise<PathChange[]> {
    const out = await this.run("diff", ["diff", "--name-status", "--no-renames", "-z", from, to, "--"]);
    const parts = out.split("\0");
    const changes: PathChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]!;
      const path = parts[i + 1]!;
      if (!status) break;
      changes.push({ path, change: status.startsWith("D") ? "delete" : "upsert" });
    }
    return changes;
  }

  /** A file's text and blob ID at a revision, or undefined when it does not exist there. */
  async read(revision: string, path: string): Promise<{ text: string; blob: string } | undefined> {
    const listing = await this.run("ls-tree", ["ls-tree", "-z", "--full-tree", revision, "--", path]);
    const line = listing.split("\0").find(Boolean);
    if (!line) return undefined;
    const [, type, blob] = line.slice(0, line.indexOf("\t")).split(" ");
    if (type !== "blob" || !blob) return undefined;
    return { text: await this.run("cat-file", ["cat-file", "blob", blob]), blob };
  }
}
