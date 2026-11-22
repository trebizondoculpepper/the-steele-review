import { execFile, spawn } from "node:child_process";
import { watch as watchPath, type FSWatcher } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join as joinPath } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Immutable text artifact store backed by a separate, private Git
 * repository on a persistent volume. Writes go through Git plumbing
 * (hash-object, a temporary index, write-tree, commit-tree and a
 * compare-and-swap update-ref), so no working tree is touched, paths can
 * never escape the repository through the filesystem, and every Git
 * command runs with an argument array (no shell).
 *
 * One store instance serialises its own writes. Readers address an exact
 * commit and path and verify the content hash, so they never depend on a
 * mutable checkout. An artifact path, once written, is immutable: rewriting
 * identical content returns the existing reference; different content is
 * refused.
 *
 * Text and provenance only. Callers must not store media or credentials.
 */

export interface ArtifactRef {
  /** Logical repository name, not a filesystem path. */
  repository: string;
  commit: string;
  path: string;
  sha256: string;
}

export const ArtifactRefSchema = z.object({
  repository: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface ArtifactStoreConfig {
  /** Filesystem path of the private artifact repository (runtime configuration). */
  repoPath: string;
  /** Logical name recorded in references. */
  repository: string;
  /** Branch holding artifacts. */
  branch?: string;
  /** Upper bound on one artifact's size in bytes. */
  maxBytes?: number;
  gitBinary?: string;
}

export type ArtifactErrorCode =
  | "invalid-path"
  | "hash-mismatch"
  | "immutable-conflict"
  | "mutation-not-authorized"
  | "stale-revision"
  | "too-large"
  | "concurrent-update"
  | "interrupted-commit"
  | "not-found"
  | "git-failed";

export class ArtifactStoreError extends Error {
  constructor(readonly code: ArtifactErrorCode) {
    super(`artifact store ${code}`);
    this.name = "ArtifactStoreError";
  }
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** Validate a relative artifact path: plain segments, no traversal, dotfiles or .git. */
export function assertArtifactPath(path: string): string {
  const segments = path.split("/");
  const valid =
    path.length > 0 &&
    path.length <= 1024 &&
    segments.every((s) => SEGMENT.test(s) && s !== ".." && s.toLowerCase() !== ".git");
  if (!valid) throw new ArtifactStoreError("invalid-path");
  return path;
}

/**
 * The only path prefixes that may be revised in place. Everything else,
 * including captured sources and saved evidence, is write-once.
 */
export const REVISABLE_PREFIXES: readonly string[] = [
  "dossier/",
  "catalogue/",
  // Reusable theme mappings (#518): corrected by normal file revisions.
  "librarian/theme-mappings/",
  // Per-article research allowance ledgers (#596): compare-and-set revisions.
  "librarian/research-allowance/",
];

/** Normalised claim records (claims/claim-<hex>.json) evolve as occurrences accumulate. */
const REVISABLE_CLAIM_RECORD = /^claims\/claim-[0-9a-f]{32}\.json$/;
/**
 * Canonical logical-article documents (#578/#579), edited in place. Only the
 * article body and metadata qualify; hash-named generation drafts and commit
 * records beside them stay write-once.
 */
const REVISABLE_ARTICLE =
  /^articles\/[a-z0-9][a-z0-9-]{0,254}\/[a-z0-9][a-z0-9-]{0,254}\/article-[0-9a-f]{24}\/article\.(md|json)$/;

/**
 * Captured-source records (#558): created write-once by collection as before,
 * and additionally revisable in place by the deliberate single-item
 * reingestion operation, which commits a new version at the same stable path
 * (Git keeps every earlier version at its commit). Owner-authorised for this
 * operation only; no other archived source artifact is revisable.
 */
const REVISABLE_CAPTURE =
  /^substack\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/[a-z0-9][a-z0-9-]{0,254}\/collected\.json$/;

/** Revisable paths that may also be created write-once through `write()`. */
function isWritableAndRevisable(path: string): boolean {
  return REVISABLE_CAPTURE.test(path);
}

export function isRevisablePath(path: string): boolean {
  return (
    REVISABLE_PREFIXES.some((p) => path.startsWith(p)) ||
    REVISABLE_CLAIM_RECORD.test(path) ||
    REVISABLE_ARTICLE.test(path) ||
    REVISABLE_CAPTURE.test(path)
  );
}

export function sha256(content: string | Uint8Array): string {
  return typeof content === "string"
    ? createHash("sha256").update(content, "utf8").digest("hex")
    : createHash("sha256").update(content).digest("hex");
}

interface GitResult {
  stdout: string;
  stderr: string;
}

/** File in the Git directory touched by the wake hook. */
export const WAKE_SIGNAL = "steele-wake";
const WAKE_HOOK_MARKER = "steele-wake-hook v2";

/**
 * reference-transaction hook: on the "committed" state, touch the wake file.
 * Deliberately minimal (POSIX sh, no parsing, no network, always exits 0):
 * deciding whether the configured branch actually moved stays in TypeScript,
 * where the woken reconciliation compares the branch head with its checkpoint.
 */
export function wakeHookScript(): string {
  return `#!/bin/sh
# ${WAKE_HOOK_MARKER}: wake the research index worker after committed ref updates.
[ "$1" = "committed" ] && : > "$(git rev-parse --git-dir)/${WAKE_SIGNAL}" 2>/dev/null
exit 0
`;
}

/**
 * Bounded retry budget for a write that lost a compare-and-swap race. Writes
 * are idempotent, so a larger budget only trades latency under extreme
 * contention for fewer spurious failures when several workers commit at once.
 */
const MAX_WRITE_ATTEMPTS = 12;

export class GitArtifactStore {
  private readonly branch: string;
  private readonly ref: string;
  private readonly maxBytes: number;
  private readonly git: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ArtifactStoreConfig) {
    this.branch = config.branch ?? "main";
    if (!/^[A-Za-z0-9._-]+$/.test(this.branch)) throw new Error("invalid branch name");
    this.ref = `refs/heads/${this.branch}`;
    this.maxBytes = config.maxBytes ?? 20 * 1024 * 1024;
    this.git = config.gitBinary ?? "git";
  }

  private run(args: string[], options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {}) {
    return new Promise<GitResult>((resolve, reject) => {
      const child = execFile(
        this.git,
        ["-C", this.config.repoPath, ...args],
        {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
            GIT_AUTHOR_NAME: "steele-archive",
            GIT_AUTHOR_EMAIL: "archive@invalid",
            GIT_COMMITTER_NAME: "steele-archive",
            GIT_COMMITTER_EMAIL: "archive@invalid",
            ...options.env,
          },
          maxBuffer: this.maxBytes + 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stderr }));
          else resolve({ stdout, stderr });
        },
      );
      // Git may exit before reading all input (e.g. repository unavailable);
      // route the resulting EPIPE into the promise instead of crashing.
      child.stdin?.on("error", (error) => reject(Object.assign(error, { stderr: "" })));
      if (typeof options.input === "string") child.stdin?.end(options.input, "utf8");
      else if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    });
  }

  /** Create the bare artifact repository if it does not already exist. Explicit, not implicit. */
  async initialise(): Promise<void> {
    await this.run(["init", "--quiet", "--bare", `--initial-branch=${this.branch}`, "."]).catch(
      () => {
        throw new ArtifactStoreError("git-failed");
      },
    );
  }

  private async head(): Promise<string | undefined> {
    try {
      const { stdout } = await this.run([
        "rev-parse",
        "--verify",
        "--quiet",
        `${this.ref}^{commit}`,
      ]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Blob ID stored at commit:path, or undefined only when Git confirms the
   * path is absent. Any read failure throws, so callers fail closed.
   */
  private async entryAt(commit: string, path: string): Promise<string | undefined> {
    let stdout: string;
    try {
      ({ stdout } = await this.run(["ls-tree", "-z", "--full-tree", commit, "--", path]));
    } catch {
      throw new ArtifactStoreError("git-failed");
    }
    for (const line of stdout.split("\0")) {
      const match = /^\d+ (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line);
      if (match && match[3] === path) {
        if (match[1] !== "blob") throw new ArtifactStoreError("immutable-conflict");
        return match[2];
      }
    }
    return undefined;
  }

  /** Raw blob bytes, never decoded as text (#277). */
  private blobBytes(blob: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        this.git,
        ["-C", this.config.repoPath, "cat-file", "blob", blob],
        {
          env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1" },
          maxBuffer: this.maxBytes + 1024 * 1024,
          encoding: "buffer",
        },
        (error, stdout) => (error ? reject(new ArtifactStoreError("git-failed")) : resolve(stdout)),
      );
    });
  }

  private async blobContent(blob: string): Promise<string> {
    try {
      return (await this.run(["cat-file", "blob", blob])).stdout;
    } catch {
      throw new ArtifactStoreError("git-failed");
    }
  }

  /**
   * Write one artifact. Serialised with other writes from this instance.
   * Returns the existing reference when identical content is already stored.
   */
  write(path: string, content: string, expectedSha256?: string): Promise<ArtifactRef> {
    const task = this.queue.then(() => this.writeRetrying(path, content, expectedSha256));
    this.queue = task.catch(() => undefined);
    return task;
  }

  /**
   * Write one binary artifact (#277), with the same write-once, size-bounded,
   * content-hashed semantics as `write`: the hash is over the exact bytes,
   * identical bytes at the same path return the existing reference, and
   * different bytes are an `immutable-conflict`. Only for paths a caller
   * reserves for raw files (for example images); indexers select their own
   * document paths and never decode these.
   */
  writeBinary(path: string, bytes: Uint8Array, expectedSha256?: string): Promise<ArtifactRef> {
    if (isRevisablePath(path)) return Promise.reject(new ArtifactStoreError("invalid-path"));
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const task = this.queue.then(() => this.writeRetrying(path, buffer, expectedSha256));
    this.queue = task.catch(() => undefined);
    return task;
  }

  /**
   * Several processes may write to one repository (the article worker and the
   * destination publishers, #315). The compare-and-swap ref update makes a lost
   * race fail with `concurrent-update` and never lose a commit; the write is
   * then retried on the new head. Write-once semantics make this safe: a
   * retry finds an identical artifact already stored, or commits on top.
   */
  private async writeRetrying(
    path: string,
    content: string | Buffer,
    expectedSha256?: string,
  ): Promise<ArtifactRef> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.writeNow(path, content, expectedSha256);
      } catch (error) {
        if (
          !(error instanceof ArtifactStoreError) ||
          // A held ref lock may be another live writer, not a stale lock:
          // retry it too, and report it only once the budget is spent.
          (error.code !== "concurrent-update" && error.code !== "interrupted-commit") ||
          attempt >= MAX_WRITE_ATTEMPTS
        )
          throw error;
        // Bounded backoff: enough for a competing writer to finish without
        // making a genuinely stuck lock wait for seconds.
        await new Promise((r) => setTimeout(r, Math.min(100, 20 * attempt) + Math.random() * 40));
      }
    }
  }

  private async writeNow(
    path: string,
    content: string | Buffer,
    expectedSha256?: string,
  ): Promise<ArtifactRef> {
    assertArtifactPath(path);
    // Revisable documents never go through the write-once path, except
    // capture records, whose first version is still created write-once.
    if (isRevisablePath(path) && !isWritableAndRevisable(path)) {
      throw new ArtifactStoreError("invalid-path");
    }
    if (Buffer.byteLength(content, "utf8") > this.maxBytes) {
      throw new ArtifactStoreError("too-large");
    }
    const digest = sha256(content);
    if (expectedSha256 !== undefined && expectedSha256 !== digest) {
      throw new ArtifactStoreError("hash-mismatch");
    }
    const parent = await this.head();
    if (parent) {
      const existing = await this.entryAt(parent, path);
      if (existing !== undefined) {
        // Compare Git blob IDs, so an existing artifact never has to be read into memory.
        let candidate: string;
        try {
          candidate = (
            await this.run(["hash-object", "--stdin"], { input: content })
          ).stdout.trim();
        } catch {
          throw new ArtifactStoreError("git-failed");
        }
        if (candidate !== existing) throw new ArtifactStoreError("immutable-conflict");
        const commit = await this.introducingCommit(parent, path);
        return { repository: this.config.repository, commit, path, sha256: digest };
      }
    }

    const commit = await this.commitBlob(path, content, parent, `Add ${path}`);
    return { repository: this.config.repository, commit, path, sha256: digest };
  }

  /** Commit one blob at a path on top of `parent` with a compare-and-swap ref update. */
  private async commitBlob(
    path: string,
    content: string | Buffer,
    parent: string | undefined,
    message: string,
    beforeCommit?: () => void,
  ): Promise<string> {
    return this.commitBlobs([{ path, content }], parent, message, beforeCommit);
  }

  /** One commit containing every given document (all or nothing). */
  private async commitBlobs(
    entries: { path: string; content: string | Buffer }[],
    parent: string | undefined,
    message: string,
    beforeCommit?: () => void,
  ): Promise<string> {
    const path = entries.map((e) => e.path).join(", ");
    const index = join(tmpdir(), `steele-artifact-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (parent) await this.run(["read-tree", parent], { env });
      else await this.run(["read-tree", "--empty"], { env });
      for (const entry of entries) {
        const blob = (
          await this.run(["hash-object", "-w", "--stdin"], { input: entry.content })
        ).stdout.trim();
        await this.run(["update-index", "--add", "--cacheinfo", `100644,${blob},${entry.path}`], {
          env,
        });
      }
      const tree = (await this.run(["write-tree"], { env })).stdout.trim();
      const commitArgs = ["commit-tree", tree, "-m", message];
      if (parent) commitArgs.push("-p", parent);
      const commit = (await this.run(commitArgs)).stdout.trim();
      // Compare-and-swap: fails if the branch moved or a stale lock remains.
      const expectedOld = parent ?? "0".repeat(40);
      try {
        beforeCommit?.();
      } catch {
        throw new ArtifactStoreError("mutation-not-authorized");
      }
      await this.run(["update-ref", "-m", `artifact ${path}`, this.ref, commit, expectedOld]);
      return commit;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      if (/\.lock/.test(stderr)) throw new ArtifactStoreError("interrupted-commit");
      if (/cannot lock ref|but expected|is at/.test(stderr)) {
        throw new ArtifactStoreError("concurrent-update");
      }
      throw new ArtifactStoreError("git-failed");
    } finally {
      await rm(index, { force: true });
    }
  }

  /**
   * Revise a document at a revisable path (see {@link REVISABLE_PREFIXES}).
   * Single writer with an expected prior version: `expectedSha256` is the
   * content hash the caller last read, or null when creating the document. A
   * mismatch fails with `stale-revision`, so a concurrent change is never
   * overwritten; the caller must reload and retry. Identical content returns
   * the current reference without a new commit. Earlier versions stay
   * readable by their commit-pinned references. A caller-supplied synchronous
   * domain fence runs when queued work starts and immediately before the ref
   * update; rejection leaves the canonical document unchanged.
   */
  revise(
    path: string,
    content: string,
    expectedSha256: string | null,
    options?: { beforeCommit: () => void },
  ): Promise<ArtifactRef> {
    const task = this.queue.then(() =>
      this.reviseNow(path, content, expectedSha256, options?.beforeCommit),
    );
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async reviseNow(
    path: string,
    content: string,
    expectedSha256: string | null,
    beforeCommit?: () => void,
  ): Promise<ArtifactRef> {
    try {
      beforeCommit?.();
    } catch {
      throw new ArtifactStoreError("mutation-not-authorized");
    }
    assertArtifactPath(path);
    if (!isRevisablePath(path)) throw new ArtifactStoreError("invalid-path");
    if (Buffer.byteLength(content, "utf8") > this.maxBytes) {
      throw new ArtifactStoreError("too-large");
    }
    const digest = sha256(content);
    const parent = await this.head();
    const blob = parent ? await this.entryAt(parent, path) : undefined;
    const current = blob === undefined ? null : sha256(await this.blobContent(blob));
    if (current !== expectedSha256) {
      // Retrying an identical write that already landed is not a conflict.
      if (current === digest && parent) {
        return {
          repository: this.config.repository,
          commit: await this.latestCommit(parent, path),
          path,
          sha256: digest,
        };
      }
      throw new ArtifactStoreError("stale-revision");
    }
    if (current === digest && parent) {
      return {
        repository: this.config.repository,
        commit: await this.latestCommit(parent, path),
        path,
        sha256: digest,
      };
    }
    const commit = await this.commitBlob(
      path,
      content,
      parent,
      `${current ? "Revise" : "Add"} ${path}`,
      beforeCommit,
    );
    return { repository: this.config.repository, commit, path, sha256: digest };
  }

  /**
   * Revise several revisable documents atomically (#579): every expected
   * version is checked against the same head and all changes land in ONE
   * commit, so a rejected update leaves every document unchanged. A document
   * already holding exactly the new content counts as applied (safe retry);
   * any other unexpected version fails the whole update with `stale-revision`.
   */
  reviseAll(
    entries: { path: string; content: string; expectedSha256: string | null }[],
  ): Promise<ArtifactRef[]> {
    const task = this.queue.then(() => this.reviseAllNow(entries));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async reviseAllNow(
    entries: { path: string; content: string; expectedSha256: string | null }[],
  ): Promise<ArtifactRef[]> {
    if (entries.length === 0 || new Set(entries.map((e) => e.path)).size !== entries.length) {
      throw new ArtifactStoreError("invalid-path");
    }
    for (const e of entries) {
      assertArtifactPath(e.path);
      if (!isRevisablePath(e.path)) throw new ArtifactStoreError("invalid-path");
      if (Buffer.byteLength(e.content, "utf8") > this.maxBytes) {
        throw new ArtifactStoreError("too-large");
      }
    }
    const parent = await this.head();
    const checked = [];
    for (const e of entries) {
      const blob = parent ? await this.entryAt(parent, e.path) : undefined;
      const current = blob === undefined ? null : sha256(await this.blobContent(blob));
      const digest = sha256(e.content);
      if (current !== e.expectedSha256 && current !== digest) {
        throw new ArtifactStoreError("stale-revision");
      }
      checked.push({ ...e, digest, applied: current === digest });
    }
    const pending = checked.filter((e) => !e.applied);
    const commit = pending.length
      ? await this.commitBlobs(
          pending.map((e) => ({ path: e.path, content: e.content })),
          parent,
          `Revise ${pending.map((e) => e.path).join(", ")}`,
        )
      : undefined;
    const refs: ArtifactRef[] = [];
    for (const e of checked) {
      refs.push({
        repository: this.config.repository,
        commit: !e.applied && commit ? commit : await this.latestCommit(commit ?? parent!, e.path),
        path: e.path,
        sha256: e.digest,
      });
    }
    return refs;
  }

  /** Newest commit on the branch that changed the path. */
  private async latestCommit(head: string, path: string): Promise<string> {
    try {
      const { stdout } = await this.run(["log", "-1", "--format=%H", head, "--", path]);
      return stdout.trim() || head;
    } catch {
      throw new ArtifactStoreError("git-failed");
    }
  }

  /** Oldest commit on the branch that contains the path, i.e. where it was introduced. */
  private async introducingCommit(head: string, path: string): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await this.run(["log", "--format=%H", "--diff-filter=A", head, "--", path]));
    } catch {
      throw new ArtifactStoreError("git-failed");
    }
    const commits = stdout.trim().split("\n").filter(Boolean);
    return commits[commits.length - 1] ?? head;
  }

  /**
   * Reference to the artifact currently stored at a path on the branch, or
   * undefined if none. Used to reconcile artifacts committed by an attempt
   * that was interrupted before recording completion.
   */
  async lookup(path: string): Promise<ArtifactRef | undefined> {
    assertArtifactPath(path);
    const head = await this.head();
    if (!head) return undefined;
    const blob = await this.entryAt(head, path);
    if (blob === undefined) return undefined;
    // Hash the stored bytes: identical to the UTF-8 text hash for documents,
    // and correct for binary artifacts (#277).
    const content = await this.blobBytes(blob);
    const commit = isRevisablePath(path)
      ? await this.latestCommit(head, path)
      : await this.introducingCommit(head, path);
    return { repository: this.config.repository, commit, path, sha256: sha256(content) };
  }

  /**
   * Paths changed on the branch since `from` (read-only). Without a usable
   * `from` (absent, unknown, or no longer an ancestor of the head), every
   * current path is returned with `full: true` so the caller reconciles from
   * scratch. Paths are artifact paths; renames appear as delete plus upsert.
   */
  async changesSince(from?: string): Promise<{
    head?: string;
    full: boolean;
    changes: { path: string; change: "upsert" | "delete" }[];
  }> {
    try {
      await this.run(["rev-parse", "--git-dir"]);
    } catch {
      throw new ArtifactStoreError("git-failed");
    }
    const head = await this.head();
    if (!head) return { full: true, changes: [] };
    let incremental = false;
    if (from && /^[0-9a-f]{40,64}$/.test(from) && (await this.commitExists(from))) {
      try {
        await this.run(["merge-base", "--is-ancestor", from, head]);
        incremental = true;
      } catch {
        incremental = false;
      }
    }
    if (!incremental) {
      const { stdout } = await this.run(["ls-tree", "-r", "-z", "--name-only", head]);
      const changes = stdout
        .split("\0")
        .filter(Boolean)
        .map((path) => ({ path, change: "upsert" as const }));
      return { head, full: true, changes };
    }
    const { stdout } = await this.run(["diff", "--name-status", "-z", "--no-renames", from!, head]);
    const parts = stdout.split("\0").filter(Boolean);
    const changes: { path: string; change: "upsert" | "delete" }[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      changes.push({ path: parts[i + 1], change: parts[i].startsWith("D") ? "delete" : "upsert" });
    }
    return { head, full: false, changes };
  }

  /**
   * Like `lookup`, but resolved against a specific branch commit (for
   * example the head a reconciliation pass is applying), so later commits
   * cannot leak into that pass. Undefined when the path is absent there.
   */
  async lookupAt(
    at: string,
    path: string,
  ): Promise<{ ref: ArtifactRef; content: string } | undefined> {
    assertArtifactPath(path);
    if (!/^[0-9a-f]{40,64}$/.test(at) || !(await this.commitExists(at))) {
      throw new ArtifactStoreError("git-failed");
    }
    const blob = await this.entryAt(at, path);
    if (blob === undefined) return undefined;
    const bytes = await this.blobBytes(blob);
    const content = bytes.toString("utf8");
    const commit = isRevisablePath(path)
      ? await this.latestCommit(at, path)
      : await this.introducingCommit(at, path);
    return {
      // The reference hashes the stored bytes (#277); content is the text view.
      ref: { repository: this.config.repository, commit, path, sha256: sha256(bytes) },
      content,
    };
  }

  /**
   * Notify when the branch may have moved (a wake-up hint only: callers must
   * still read committed revisions). Watches the repository's own ref
   * storage, wherever Git keeps it for this layout. `active` is false when
   * notifications are unavailable, in which case callers rely on polling.
   */
  async watchBranch(onChange: () => void): Promise<{ active: boolean; close(): void }> {
    let gitDir: string;
    try {
      gitDir = (await this.run(["rev-parse", "--git-dir"])).stdout.trim();
    } catch {
      return { active: false, close: () => undefined };
    }
    if (!isAbsolute(gitDir)) gitDir = joinPath(this.config.repoPath, gitDir);
    const watchers: FSWatcher[] = [];
    try {
      watchers.push(watchPath(joinPath(gitDir, "refs", "heads"), () => onChange()));
    } catch {
      // No loose refs directory: packed refs below, or polling.
    }
    try {
      // packed-refs changes, and the wake signal written by the installed
      // reference-transaction hook (see installWakeHook).
      watchers.push(
        watchPath(
          gitDir,
          (_event, name) => (name === "packed-refs" || name === WAKE_SIGNAL) && onChange(),
        ),
      );
    } catch {
      // Polling covers it.
    }
    return {
      active: watchers.length > 0,
      close: () => {
        for (const w of watchers) w.close();
      },
    };
  }

  /**
   * Install a fast `reference-transaction` hook that touches a wake file the
   * watcher observes after committed ref updates (#251). Whether this store's
   * branch moved is decided in TypeScript by the woken reconciliation.
   * The hook does no other work and never blocks the update.
   * An existing hook that is not ours is left alone and reported.
   */
  async installWakeHook(): Promise<"installed" | "unchanged" | "foreign-hook"> {
    const { stdout } = await this.run(["rev-parse", "--git-dir"]);
    let gitDir = stdout.trim();
    if (!isAbsolute(gitDir)) gitDir = joinPath(this.config.repoPath, gitDir);
    const { stdout: hooksOut } = await this.run(["rev-parse", "--git-path", "hooks"]);
    let hooksDir = hooksOut.trim();
    if (!isAbsolute(hooksDir)) hooksDir = joinPath(this.config.repoPath, hooksDir);
    const path = joinPath(hooksDir, "reference-transaction");
    const script = wakeHookScript();
    let existing: string | undefined;
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = undefined;
    }
    if (existing === script) return "unchanged";
    if (existing !== undefined && !existing.includes("steele-wake-hook")) return "foreign-hook";
    await writeFile(path, script, "utf8");
    await chmod(path, 0o755);
    return "installed";
  }

  private async commitExists(commit: string): Promise<boolean> {
    try {
      await this.run(["cat-file", "-e", `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Paths of artifacts currently stored under a directory prefix on the
   * branch, sorted, at most `limit` (read-only; never writes).
   */
  async list(prefix: string, limit: number, after?: string): Promise<string[]> {
    assertArtifactPath(prefix);
    // An unreadable or non-Git archive is a failure, not an empty archive.
    try {
      await this.run(["rev-parse", "--git-dir"]);
    } catch {
      throw new ArtifactStoreError("git-failed");
    }
    const head = await this.head();
    if (!head) return [];
    return this.listFrom(head, prefix, limit, after);
  }

  /**
   * Paths of artifacts stored under a prefix at one commit, sorted, at most
   * `limit`. Enumerating the current tree would let a pinned load see paths
   * that did not exist at that revision, or miss ones removed since (#249).
   */
  async listAt(at: string, prefix: string, limit: number, after?: string): Promise<string[]> {
    assertArtifactPath(prefix);
    if (!/^[0-9a-f]{40,64}$/.test(at) || !(await this.commitExists(at))) {
      throw new ArtifactStoreError("git-failed");
    }
    return this.listFrom(at, prefix, limit, after);
  }

  private async listFrom(
    revision: string,
    prefix: string,
    limit: number,
    after?: string,
  ): Promise<string[]> {
    const bound = Math.max(1, Math.min(Math.trunc(limit), 100_000));
    // Streamed and stopped at the bound, so a large archive is never
    // buffered whole. Git lists tree entries in path order.
    const paths = await new Promise<string[]>((resolve, reject) => {
      const found: string[] = [];
      let pending = "";
      let done = false;
      const child = spawn(
        this.git,
        [
          "-C",
          this.config.repoPath,
          "ls-tree",
          "-r",
          "-z",
          "--name-only",
          "--full-tree",
          revision,
          "--",
          `${prefix}/`,
        ],
        {
          env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1" },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (error) reject(error);
        else resolve(found);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (done) return;
        const parts = (pending + chunk).split("\0");
        pending = parts.pop() ?? "";
        for (const part of parts) {
          // Paths at or before the cursor are skipped and do not use the budget.
          if (part && (after === undefined || part > after)) found.push(part);
          if (found.length >= bound) {
            child.kill();
            return finish();
          }
        }
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) =>
        code === 0 ? finish() : finish(new Error(`git exited ${code}`)),
      );
    }).catch(() => {
      throw new ArtifactStoreError("git-failed");
    });
    return paths.sort();
  }

  /** Read the exact referenced version and verify its hash. */
  async read(ref: ArtifactRef): Promise<string> {
    const valid = ArtifactRefSchema.parse(ref);
    if (valid.repository !== this.config.repository) throw new ArtifactStoreError("not-found");
    assertArtifactPath(valid.path);
    const blob = await this.entryAt(valid.commit, valid.path).catch((error: unknown) => {
      // An unknown commit is a missing artifact; other failures stay failures.
      if (error instanceof ArtifactStoreError && error.code === "git-failed") {
        return this.commitExists(valid.commit).then((exists) => {
          if (exists) throw error;
          return undefined;
        });
      }
      throw error;
    });
    if (blob === undefined) throw new ArtifactStoreError("not-found");
    const content = await this.blobContent(blob);
    if (sha256(content) !== valid.sha256) throw new ArtifactStoreError("hash-mismatch");
    return content;
  }

  /** Read the exact referenced binary artifact as bytes and verify their hash (#277). */
  async readBinary(ref: ArtifactRef): Promise<Buffer> {
    const valid = ArtifactRefSchema.parse(ref);
    if (valid.repository !== this.config.repository) throw new ArtifactStoreError("not-found");
    assertArtifactPath(valid.path);
    if (!(await this.commitExists(valid.commit))) throw new ArtifactStoreError("not-found");
    const blob = await this.entryAt(valid.commit, valid.path);
    if (blob === undefined) throw new ArtifactStoreError("not-found");
    const bytes = await this.blobBytes(blob);
    if (sha256(bytes) !== valid.sha256) throw new ArtifactStoreError("hash-mismatch");
    return bytes;
  }
}
