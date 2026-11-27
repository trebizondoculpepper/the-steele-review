import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { executableGitRunner, GitError, GitRunFailure, type GitRunner, type GitRunOptions } from "./runner.js";

/**
 * The common Git service (#949).
 *
 * Application modules ask a GitRepository for facts and changes; they never
 * build Git arguments or start Git themselves. Policy (what a collection is,
 * which records a poller writes) stays with the callers.
 *
 * Reads always address an exact revision, never the working tree, so callers
 * see committed content only. Absence is a result (null or an empty list);
 * technical failures are GitErrors with a category.
 *
 * Commits use Git plumbing, as the earlier GitArtifactStore did: blobs and a
 * temporary index build a tree from the parent commit, `commit-tree` makes the
 * commit, and a compare-and-swap `update-ref` moves the branch only if it is
 * still at the expected parent. No working tree is touched, a lost race is a
 * `conflict` (never a lost commit), and a change that leaves the tree as it was
 * makes no commit at all.
 *
 * The implementation wraps the installed Git executable rather than a Git
 * library: it is what the deployment already runs, it is exactly Git's own
 * behaviour, and the earlier store proved the plumbing approach.
 */

export interface TreeEntry {
  path: string;
  /** Git object ID of the content. */
  blob: string;
}

export interface FileAtRevision {
  content: Buffer;
  blob: string;
}

export interface PathChange {
  path: string;
  change: "added" | "modified" | "deleted";
}

export interface FileWrite {
  path: string;
  content: string | Buffer;
}

export interface CommitRequest {
  /** Branch to move, default `main`. */
  branch?: string;
  /**
   * The commit the branch must still point at, or null for a branch with no
   * commits yet. Omit to use the branch's current head (a read just before
   * committing; a concurrent writer still causes a `conflict`).
   */
  parent?: string | null;
  writes?: readonly FileWrite[];
  deletes?: readonly string[];
  message: string;
  author?: { name: string; email: string };
  signal?: AbortSignal;
}

export interface CommitResult {
  /** The new commit, or the unchanged head when nothing changed. */
  commit: string | null;
  /** False when the requested writes and deletes left the tree as it was. */
  changed: boolean;
}

const DEFAULT_AUTHOR = { name: "steele-review", email: "steele-review@invalid" };
const NO_COMMIT = "0".repeat(40);
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** A repository-relative path: plain segments, no `..`, no `.git`, no leading slash. */
export function assertRepositoryPath(path: string, operation = "path"): string {
  const segments = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    posix.normalize(path) !== path ||
    segments.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")
  )
    throw new GitError("invalid-path", operation);
  return path;
}

/** A revision argument: an object ID or a plain ref name, never an option. */
function assertRevision(revision: string, operation: string): string {
  if (!revision || revision.startsWith("-") || /[\s\0:^~?*[\\]|\.\./.test(revision) || revision.length > 200)
    throw new GitError("invalid-path", operation);
  return revision;
}

export class GitRepository {
  private readonly runner: GitRunner;

  constructor(
    readonly root: string,
    options: { runner?: GitRunner } = {},
  ) {
    this.runner = options.runner ?? executableGitRunner();
  }

  private async run(operation: string, args: readonly string[], options?: GitRunOptions): Promise<string> {
    return (await this.runBytes(operation, args, options)).toString("utf8");
  }

  private async runBytes(operation: string, args: readonly string[], options?: GitRunOptions): Promise<Buffer> {
    try {
      return (await this.runner(this.root, args, options)).stdout;
    } catch (error) {
      throw classify(operation, error);
    }
  }

  /** Confirms the root is a readable repository; throws GitError otherwise. */
  async check(signal?: AbortSignal): Promise<void> {
    await this.run("rev-parse", ["rev-parse", "--git-dir"], { signal });
  }

  /** The commit a revision names, or null when it names nothing (an unknown ref, an unborn branch). */
  async resolve(revision = "HEAD", signal?: AbortSignal): Promise<string | null> {
    await this.check(signal);
    try {
      const out = await this.run("rev-parse", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${assertRevision(revision, "rev-parse")}^{commit}`], { signal });
      return out.trim() || null;
    } catch (error) {
      // --verify --quiet exits 1 without output for a name that resolves to nothing.
      if (error instanceof GitError && error.code === "failed") return null;
      throw error;
    }
  }

  /** Whether `ancestor` is reachable from `descendant`; false when either is unknown. */
  async isAncestor(ancestor: string, descendant: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.run("merge-base", ["merge-base", "--is-ancestor", assertRevision(ancestor, "merge-base"), assertRevision(descendant, "merge-base")], { signal });
      return true;
    } catch (error) {
      if (error instanceof GitError && error.code === "failed") return false;
      throw error;
    }
  }

  /** Immediate child directories of `directory` (default: the root) at a revision. */
  async listDirectories(revision: string, directory = "", signal?: AbortSignal): Promise<string[]> {
    const target = directory ? `${assertRepositoryPath(directory, "ls-tree")}/` : "";
    const out = await this.run("ls-tree", ["ls-tree", "-z", "-d", "--full-tree", assertRevision(revision, "ls-tree"), "--", ...(target ? [target] : [])], { signal });
    return out
      .split("\0")
      .filter(Boolean)
      .map((line) => line.slice(line.indexOf("\t") + 1))
      .map((path) => (target ? path.slice(target.length) : path));
  }

  /** Every file at a revision, optionally only under `directory`, with blob IDs. */
  async listFiles(revision: string, directory = "", signal?: AbortSignal): Promise<TreeEntry[]> {
    const scope = directory ? [`${assertRepositoryPath(directory, "ls-tree")}/`] : [];
    const out = await this.run("ls-tree", ["ls-tree", "-r", "-z", "--full-tree", assertRevision(revision, "ls-tree"), "--", ...scope], { signal });
    const entries: TreeEntry[] = [];
    for (const line of out.split("\0")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      const [, type, blob] = line.slice(0, tab).split(" ");
      if (type === "blob" && blob) entries.push({ path: line.slice(tab + 1), blob });
    }
    return entries;
  }

  /** A file's bytes and blob ID at a revision, or null when there is no file there. */
  async readFile(revision: string, path: string, signal?: AbortSignal): Promise<FileAtRevision | null> {
    const listing = await this.run("ls-tree", ["ls-tree", "-z", "--full-tree", assertRevision(revision, "ls-tree"), "--", assertRepositoryPath(path, "ls-tree")], { signal });
    const line = listing.split("\0").find(Boolean);
    if (!line) return null;
    const [, type, blob] = line.slice(0, line.indexOf("\t")).split(" ");
    if (type !== "blob" || !blob) return null;
    return { content: await this.runBytes("cat-file", ["cat-file", "blob", blob], { signal }), blob };
  }

  /** A file's UTF-8 text at a revision, or null. */
  async readText(revision: string, path: string, signal?: AbortSignal): Promise<{ text: string; blob: string } | null> {
    const file = await this.readFile(revision, path, signal);
    return file && { text: file.content.toString("utf8"), blob: file.blob };
  }

  /**
   * Files that differ between two revisions, optionally only under `directory`.
   * Renames are reported as a deletion and an addition.
   */
  async compare(from: string, to: string, directory = "", signal?: AbortSignal): Promise<PathChange[]> {
    const scope = directory ? [`${assertRepositoryPath(directory, "diff")}/`] : [];
    const out = await this.run("diff", ["diff-tree", "-r", "-z", "--no-renames", "--name-status", assertRevision(from, "diff"), assertRevision(to, "diff"), "--", ...scope], { signal });
    const parts = out.split("\0");
    const changes: PathChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]!;
      if (!status) break;
      changes.push({ path: parts[i + 1]!, change: status.startsWith("D") ? "deleted" : status.startsWith("A") ? "added" : "modified" });
    }
    return changes;
  }

  /** Commit writes and deletes as one commit on a branch, without a working tree. */
  async commit(request: CommitRequest): Promise<CommitResult> {
    const branch = request.branch ?? "main";
    if (!BRANCH.test(branch) || branch.includes("..") || branch.endsWith(".lock")) throw new GitError("invalid-path", "commit");
    const writes = request.writes ?? [];
    const deletes = request.deletes ?? [];
    const seen = new Set<string>();
    for (const path of [...writes.map((w) => w.path), ...deletes]) {
      assertRepositoryPath(path, "commit");
      if (seen.has(path)) throw new GitError("invalid-path", "commit");
      seen.add(path);
    }
    const signal = request.signal;
    const ref = `refs/heads/${branch}`;
    const parent = request.parent === undefined ? await this.resolve(ref, signal) : request.parent;
    if (parent !== null && !OBJECT_ID.test(parent)) throw new GitError("invalid-path", "commit");

    const index = join(tmpdir(), `steele-git-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.run("read-tree", parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env, signal });
      for (const write of writes) {
        const blob = (await this.run("hash-object", ["hash-object", "-w", "--stdin"], { input: write.content, signal })).trim();
        await this.run("update-index", ["update-index", "--add", "--cacheinfo", `100644,${blob},${write.path}`], { env, signal });
      }
      // `--index-info` with mode 0 removes entries without needing a work tree (bare repositories).
      if (deletes.length)
        await this.run("update-index", ["update-index", "-z", "--index-info"], {
          env,
          signal,
          input: deletes.map((path) => `0 ${NO_COMMIT}\t${path}\0`).join(""),
        });
      const tree = (await this.run("write-tree", ["write-tree"], { env, signal })).trim();
      if (parent) {
        const parentTree = (await this.run("rev-parse", ["rev-parse", `${parent}^{tree}`], { signal })).trim();
        // Repeating identical content makes no commit, so a repeated poll creates no duplicate history.
        if (parentTree === tree) return { commit: parent, changed: false };
      }
      const author = request.author ?? DEFAULT_AUTHOR;
      const identity = {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      };
      const commit = (
        await this.run("commit-tree", ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], {
          input: request.message,
          env: identity,
          signal,
        })
      ).trim();
      // Compare-and-swap: fails if the branch moved since `parent`.
      await this.run("update-ref", ["update-ref", "-m", "commit", ref, commit, parent ?? NO_COMMIT], { signal });
      return { commit, changed: true };
    } finally {
      await rm(index, { force: true });
    }
  }
}

function classify(operation: string, error: unknown): GitError {
  if (error instanceof GitError) return error;
  if (!(error instanceof GitRunFailure)) return new GitError("failed", operation);
  if (error.reason === "cancelled") return new GitError("cancelled", operation);
  if (error.reason === "timeout") return new GitError("timeout", operation);
  if (error.reason === "spawn") return new GitError("failed", operation);
  const message = error.stderr;
  if (/not a git repository|cannot change to|No such file or directory|unsafe repository|dubious ownership/i.test(message))
    return new GitError("not-a-repository", operation);
  if (operation === "update-ref" && /cannot lock ref|but expected|is at |\.lock/i.test(message)) return new GitError("conflict", operation);
  return new GitError("failed", operation);
}
