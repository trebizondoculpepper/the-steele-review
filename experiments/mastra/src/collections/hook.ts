import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GitRepository } from "../common/git/index.js";

/**
 * The collections repository's indexing hook (#952).
 *
 * Installed as Git's `reference-transaction` hook, so it runs after every
 * branch update: ordinary `git commit`, merges, and the plumbing commits the
 * common Git service makes (which never run `post-commit`). On a committed
 * update to a branch it runs the globally installed `steele-collections` CLI,
 * resolved by name on PATH under the account that runs Git.
 *
 * The hook never blocks or undoes a commit: Git has already committed when it
 * runs, and a failure is reported on standard error with the recovery command.
 * Settings come from an environment file written at install time, so the hook
 * holds no paths or credentials itself.
 */

export const HOOK_NAME = "reference-transaction";
const MARKER = "# steele-collections indexing hook";

export function hookScript(envFile: string): string {
  return `#!/bin/sh
${MARKER} (#952). Reinstall with: steele-collections install-hook
# Runs after each branch update; never blocks or undoes a commit.
[ "$1" = "committed" ] || exit 0
branch=0
while read -r old new ref; do
  case "$ref" in refs/heads/*) branch=1 ;; esac
done
[ "$branch" = 1 ] || exit 0
if [ -f ${shellQuote(envFile)} ]; then
  set -a
  . ${shellQuote(envFile)}
  set +a
fi
if ! steele-collections reconcile --quiet; then
  echo "steele-collections: indexing did not complete; the commit is kept." >&2
  echo "steele-collections: recover with: steele-collections reconcile" >&2
fi
exit 0
`;
}

/** Single-quote for POSIX sh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface InstallResult {
  hookPath: string;
  envFile: string;
  replaced: boolean;
}

/**
 * Write the hook and its environment file. An existing hook that this tool did
 * not install is never overwritten.
 */
export async function installHook(repo: GitRepository, settings: Record<string, string>): Promise<InstallResult> {
  await repo.check();
  const hooks = await repo.gitPath("hooks");
  const hookPath = join(hooks, HOOK_NAME);
  const envFile = join(dirname(hooks), "steele-collections.env");
  let existing: string | undefined;
  try {
    existing = await readFile(hookPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined && !existing.includes(MARKER)) throw new Error(`refusing to replace an existing ${HOOK_NAME} hook that steele-collections did not install`);

  const lines = Object.entries(settings)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("invalid setting name");
      return `${key}=${shellQuote(value)}`;
    });
  await mkdir(hooks, { recursive: true });
  await writeAtomically(envFile, `# steele-collections hook settings (#952)\n${lines.join("\n")}\n`, 0o600);
  await writeAtomically(hookPath, hookScript(envFile), 0o755);
  return { hookPath, envFile, replaced: existing !== undefined };
}

async function writeAtomically(path: string, content: string, mode: number) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}
