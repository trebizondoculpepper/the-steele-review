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
  const dir = shellQuote(dirname(envFile));
  return `#!/bin/sh
${MARKER} (#952). Reinstall with: steele-collections install-hook
# Runs after each branch update; never blocks or undoes a commit. Indexing runs
# in the background: the hook waits up to STEELE_HOOK_WAIT_SECONDS (default 20)
# to report the outcome, then leaves the pass running and returns, so a slow
# pass never holds up the Git operation that triggered it.
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
log=${dir}/steele-collections.log
out=$(mktemp) || exit 0
status=$(mktemp) || exit 0
: > "$status"
(
  steele-collections reconcile --quiet > "$out" 2>&1
  rc=$?
  { date -u +%Y-%m-%dT%H:%M:%SZ; cat "$out"; } >> "$log" 2>/dev/null
  echo "$rc" > "$status.done"
) < /dev/null > /dev/null 2>&1 &
wait_ticks=$(( \${STEELE_HOOK_WAIT_SECONDS:-20} * 5 ))
while [ ! -f "$status.done" ] && [ "$wait_ticks" -gt 0 ]; do
  sleep 0.2
  wait_ticks=$((wait_ticks - 1))
done
if [ -f "$status.done" ]; then
  if [ "$(cat "$status.done")" != 0 ]; then
    cat "$out" >&2
    echo "steele-collections: indexing did not complete; the commit is kept." >&2
    echo "steele-collections: recover with: steele-collections reconcile" >&2
  fi
  rm -f "$out" "$status" "$status.done"
else
  echo "steele-collections: indexing continues in the background; see $log" >&2
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
