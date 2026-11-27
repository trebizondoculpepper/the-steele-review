import { execFile } from "node:child_process";

/**
 * The Git transport (#949): the only code that starts a Git process.
 *
 * It runs the installed `git` executable with an argument array (no shell), an
 * explicit repository, a sanitised environment and a timeout, and reports
 * failures as GitError categories. Git's own messages are kept off the error
 * message (they can contain private paths); the service reads them only to
 * classify a failure.
 *
 * Tests can inject their own runner to fake or observe Git.
 */

export type GitErrorCode =
  /** The root is missing, unreadable, or not a Git repository. */
  | "not-a-repository"
  /** A compare-and-swap ref update lost a race, or a ref lock is held. */
  | "conflict"
  /** A path is absolute, escapes the repository, or names Git's own files. */
  | "invalid-path"
  /** The caller's AbortSignal fired. */
  | "cancelled"
  /** Git did not finish within the time limit. */
  | "timeout"
  /** Any other failure, including Git not being installed. */
  | "failed";

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    /** The Git subcommand, never its arguments. */
    readonly operation: string,
  ) {
    super(`git ${operation}: ${code}`);
    this.name = "GitError";
  }
}

export interface GitRunOptions {
  /** Bytes for standard input. */
  input?: string | Buffer;
  /** Extra environment for this call only, e.g. GIT_INDEX_FILE. */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface GitOutput {
  stdout: Buffer;
}

/** A failure from the transport: exit status and Git's message, for classification only. */
export class GitRunFailure extends Error {
  constructor(
    readonly exitCode: number | undefined,
    readonly stderr: string,
    readonly reason: "exit" | "timeout" | "cancelled" | "spawn",
  ) {
    super(`git failed: ${reason}`);
    this.name = "GitRunFailure";
  }
}

export type GitRunner = (root: string, args: readonly string[], options?: GitRunOptions) => Promise<GitOutput>;

/**
 * Variables that would make Git read or write a different repository, index or
 * object store than the one named, or pick up machine-wide configuration.
 */
export const GIT_LOCATION_ENVIRONMENT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;

export function sanitisedGitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };
  for (const name of GIT_LOCATION_ENVIRONMENT) delete copy[name];
  for (const name of Object.keys(copy)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete copy[name];
  return copy;
}

export interface ExecutableRunnerOptions {
  /** Per-call time limit; default 60 seconds. */
  timeoutMs?: number;
  /** Largest output accepted; default 256 MiB. */
  maxBytes?: number;
  binary?: string;
}

/** The default transport: the installed Git executable. */
export function executableGitRunner(options: ExecutableRunnerOptions = {}): GitRunner {
  const timeout = options.timeoutMs ?? 60_000;
  const maxBuffer = options.maxBytes ?? 256 * 1024 * 1024;
  const binary = options.binary ?? "git";
  return (root, args, call = {}) => {
    if (call.signal?.aborted) return Promise.reject(new GitRunFailure(undefined, "", "cancelled"));
    return new Promise((resolve, reject) => {
      const child = execFile(
        binary,
        // safe.directory: the repository is often a mounted volume owned by another user.
        ["-C", root, "-c", "core.quotepath=off", "-c", `safe.directory=${root}`, ...args],
        {
          env: { ...sanitisedGitEnvironment(), ...call.env },
          encoding: "buffer",
          maxBuffer,
          timeout,
          killSignal: "SIGKILL",
          signal: call.signal,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout });
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
          const reason = call.signal?.aborted
            ? "cancelled"
            : failure.killed
              ? "timeout"
              : typeof failure.code === "number"
                ? "exit"
                : "spawn";
          reject(new GitRunFailure(typeof failure.code === "number" ? failure.code : undefined, stderr.toString("utf8"), reason));
        },
      );
      // Git may exit before reading all input; route EPIPE into the result.
      child.stdin?.on("error", () => undefined);
      if (call.input !== undefined) child.stdin?.end(call.input);
      else child.stdin?.end();
    });
  };
}
