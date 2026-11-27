import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/collections/cli.js";
import { installHook, shellQuote } from "../src/collections/hook.js";
import { GitRepository } from "../src/common/git/index.js";

/** A repository with the hook installed and a stub `steele-collections` first on PATH. */
async function harness(stubExit = 0, stubSleep = 0) {
  const base = mkdtempSync(join(tmpdir(), "hook-"));
  const root = join(base, "collections");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  const bin = join(base, "bin");
  mkdirSync(bin);
  const calls = join(base, "calls.log");
  writeFileSync(
    join(bin, "steele-collections"),
    `#!/bin/sh\necho "$* namespace=$STEELE_INDEX_NAMESPACE root=$STEELE_COLLECTIONS_ROOT" >> ${shellQuote(calls)}\nsleep ${stubSleep}\nexit ${stubExit}\n`,
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const result = await installHook(new GitRepository(root), { STEELE_INDEX_NAMESPACE: "steele-review-hooktest", STEELE_COLLECTIONS_ROOT: root });
  const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
  const calledTimes = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);
  return { root, env, result, git, calledTimes };
}

test("an ordinary commit runs the globally installed CLI by name with the saved settings", async () => {
  const h = await harness();
  assert.ok(statSync(h.result.hookPath).mode & 0o100, "the hook is executable");
  assert.equal(statSync(h.result.envFile).mode & 0o777, 0o600, "settings are private to the account");
  writeFileSync(join(h.root, "a.json"), "{}");
  h.git("add", "a.json");
  const commit = h.git("commit", "-q", "-m", "add");
  assert.equal(commit.status, 0);
  assert.deepEqual(h.calledTimes(), [`reconcile --quiet namespace=steele-review-hooktest root=${h.root}`]);
});

test("plumbing commits from the common Git service also trigger indexing; tag updates do not", async () => {
  const h = await harness();
  // The service's Git runs with the account's PATH, where the CLI is installed.
  const saved = process.env.PATH;
  process.env.PATH = h.env.PATH;
  try {
    await new GitRepository(h.root).commit({ parent: null, writes: [{ path: "feeds/collection.json", content: "{}" }], message: "poller" });
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(h.calledTimes().length, 1);
  h.git("tag", "v1");
  assert.equal(h.calledTimes().length, 1, "a tag is not a branch update");
});

test("a failing indexing run reports the recovery command and keeps the commit", async () => {
  const h = await harness(1);
  writeFileSync(join(h.root, "bad.json"), "{");
  h.git("add", "bad.json");
  const commit = h.git("commit", "-q", "-m", "bad record");
  assert.equal(commit.status, 0, "Git keeps the commit");
  assert.match(commit.stderr, /indexing did not complete; the commit is kept/);
  assert.match(commit.stderr, /recover with: steele-collections reconcile/);
  assert.equal(h.git("log", "--format=%s", "-1").stdout.trim(), "bad record");
});

test("an existing hook from elsewhere is never replaced; reinstalling our own is allowed", async () => {
  const h = await harness();
  await installHook(new GitRepository(h.root), { STEELE_INDEX_NAMESPACE: "x" });
  writeFileSync(h.result.hookPath, "#!/bin/sh\necho someone else's hook\n", { mode: 0o755 });
  await assert.rejects(installHook(new GitRepository(h.root), {}), /refusing to replace/);
  assert.match(readFileSync(h.result.hookPath, "utf8"), /someone else's hook/);
});

test("settings values are quoted safely in the environment file", async () => {
  const h = await harness();
  await installHook(new GitRepository(h.root), { STEELE_INDEX_NAMESPACE: "steele-review-x", STEELE_APP_DIR: "/tmp/it's $(not run)" });
  const out = spawnSync("sh", ["-c", `set -a; . ${shellQuote(h.result.envFile)}; printf %s "$STEELE_APP_DIR"`], { encoding: "utf8" });
  assert.equal(out.stdout, "/tmp/it's $(not run)");
});

test("the CLI reports usage and configuration errors with exit status 2", async () => {
  const sink = () => {
    let text = "";
    return { stream: { write: (s: string) => ((text += s), true) } as unknown as NodeJS.WritableStream, text: () => text };
  };
  const out = sink();
  const err = sink();
  assert.equal(await main([], {}, out.stream, err.stream), 2);
  assert.match(err.text(), /usage: steele-collections/);
  const err2 = sink();
  assert.equal(await main(["reconcile"], {}, out.stream, err2.stream), 2);
  assert.match(err2.text(), /STEELE_CONFIG_PATH is not set/);
  const err3 = sink();
  assert.equal(await main(["install-hook"], {}, out.stream, err3.stream), 2);
  assert.match(err3.text(), /give --repo/);
});

test("a slow pass never holds up the Git operation beyond the hook deadline (review on #957)", async () => {
  const h = await harness(0, 4);
  writeFileSync(join(h.root, "a.json"), "{}");
  h.git("add", "a.json");
  const started = Date.now();
  const commit = spawnSync("git", ["-C", h.root, "commit", "-q", "-m", "slow"], { env: { ...h.env, STEELE_HOOK_WAIT_SECONDS: "1" }, encoding: "utf8" });
  const elapsed = Date.now() - started;
  assert.equal(commit.status, 0);
  assert.ok(elapsed < 3000, `the commit returned after ${elapsed} ms`);
  assert.match(commit.stderr, /indexing continues in the background; see .*steele-collections\.log/);
  // The pass finishes on its own and records its outcome in the log.
  const log = join(h.root, ".git", "steele-collections.log");
  for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 200));
  assert.ok(existsSync(log), "the background pass logged its outcome");
  assert.equal(h.calledTimes().length, 1);
});

test("passes take a cross-process lock; an abandoned lock is taken over (review on #957)", async () => {
  const { withLock, LockTimeoutError } = await import("../src/collections/lock.js");
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const lock = join(dir, "state", "collection-index.json.lock");
  const order: string[] = [];
  const slow = (name: string) => withLock(lock, async () => {
    order.push(`${name}-start`);
    await new Promise((r) => setTimeout(r, 100));
    order.push(`${name}-end`);
  }, { pollMs: 10 });
  await Promise.all([slow("a"), slow("b")]);
  assert.deepEqual(order.slice(0, 2), [`${order[0]!.split("-")[0]}-start`, `${order[0]!.split("-")[0]}-end`], "passes never interleave");

  // Held by a live process: wait times out.
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), `${process.pid}\n`);
  await assert.rejects(withLock(lock, async () => 1, { waitMs: 100, pollMs: 10 }), LockTimeoutError);
  // Held by a process that has gone: taken over.
  writeFileSync(join(lock, "owner"), "999999\n");
  assert.equal(await withLock(lock, async () => "ran", { waitMs: 1000, pollMs: 10 }), "ran");
  assert.equal(existsSync(lock), false, "the lock is released");
});
