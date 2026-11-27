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
  const tmpDir = mkdtempSync(join(tmpdir(), "hook-tmp-"));
  const commit = spawnSync("git", ["-C", h.root, "commit", "-q", "-m", "slow"], { env: { ...h.env, STEELE_HOOK_WAIT_SECONDS: "1", TMPDIR: tmpDir }, encoding: "utf8" });
  const elapsed = Date.now() - started;
  assert.equal(commit.status, 0);
  assert.ok(elapsed < 3000, `the commit returned after ${elapsed} ms`);
  assert.match(commit.stderr, /indexing continues in the background; see .*steele-collections\.log/);
  // The pass finishes on its own and records its outcome in the log.
  const log = join(h.root, ".git", "steele-collections.log");
  for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 200));
  assert.ok(existsSync(log), "the background pass logged its outcome");
  // ...and removed its temporary files once nobody was waiting for them.
  const { readdirSync } = await import("node:fs");
  await new Promise((r) => setTimeout(r, 300));
  const leftovers = readdirSync(tmpDir).filter((n) => n.startsWith("tmp."));
  assert.deepEqual(leftovers, [], "no temporary files are left behind");
  assert.equal(h.calledTimes().length, 1);
});

test("passes never interleave, and exactly one of many contenders takes over an abandoned lock (review on #957)", async () => {
  const { withLock, LOCK_REF } = await import("../src/collections/lock.js");
  const root = mkdtempSync(join(tmpdir(), "lock-"));
  execFileSync("git", ["init", "-q", "--bare", root]);
  const repo = new GitRepository(root);
  let inside = 0;
  let overlapped = false;
  const pass = () =>
    withLock(repo, async () => {
      inside++;
      if (inside > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 30));
      inside--;
    }, { pollMs: 5 });
  await Promise.all([pass(), pass(), pass()]);
  assert.equal(overlapped, false);

  // An abandoned lock: its owner on this host has exited. Five contenders race for it.
  const dead = await repo.writeBlob(JSON.stringify({ host: "this-host", pid: 999999, token: "t", at: Date.now() }));
  await repo.swapRef(LOCK_REF, dead, null);
  const contenders = Array.from({ length: 5 }, () =>
    withLock(repo, async () => {
      inside++;
      if (inside > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 30));
      inside--;
    }, { pollMs: 5, host: "this-host", isAlive: (pid) => pid !== 999999 }),
  );
  await Promise.all(contenders);
  assert.equal(overlapped, false, "no two contenders were ever inside together");
  assert.equal(await repo.readRef(LOCK_REF), null, "the lock is released at the end");
});

test("a live owner's lock makes others wait; a stale or unreadable one is taken over; release only removes our own (review on #957)", async () => {
  const { withLock, LockTimeoutError, LOCK_REF } = await import("../src/collections/lock.js");
  const root = mkdtempSync(join(tmpdir(), "lock-"));
  execFileSync("git", ["init", "-q", "--bare", root]);
  const repo = new GitRepository(root);
  const live = await repo.writeBlob(JSON.stringify({ host: "h", pid: 1, token: "x", at: Date.now() }));
  await repo.swapRef(LOCK_REF, live, null);
  await assert.rejects(withLock(repo, async () => 1, { waitMs: 50, pollMs: 5, host: "h", isAlive: () => true }), LockTimeoutError);
  await assert.rejects(withLock(repo, async () => 1, { waitMs: 50, pollMs: 5, host: "other-host", isAlive: () => false }), LockTimeoutError, "another host's live-looking lock is respected until stale");
  await assert.rejects(
    withLock(repo, async () => 1, { staleMs: 1, now: () => Date.now() + 10, waitMs: 50, pollMs: 5, host: "h", isAlive: () => true }),
    LockTimeoutError,
    "a live local owner is never taken over, however old its lock",
  );
  assert.equal(await withLock(repo, async () => "stale", { staleMs: 1, now: () => Date.now() + 10, pollMs: 5, host: "elsewhere", isAlive: () => true }), "stale");
  const junk = await repo.writeBlob("not json");
  await repo.swapRef(LOCK_REF, junk, null);
  assert.equal(await withLock(repo, async () => "unreadable", { pollMs: 5 }), "unreadable");
  // A pass whose lock was taken over does not delete the new owner's lock.
  let stolen: string | null = null;
  await withLock(repo, async () => {
    const other = await repo.writeBlob(JSON.stringify({ host: "h2", pid: 2, token: "y", at: Date.now() }));
    await repo.swapRef(LOCK_REF, other, await repo.readRef(LOCK_REF));
    stolen = other;
  }, { pollMs: 5 });
  assert.equal(await repo.readRef(LOCK_REF), stolen);
});

test("install-hook saves absolute paths, so the hook resolves them as the installer did (review on #957)", async () => {
  const base = mkdtempSync(join(tmpdir(), "hook-paths-"));
  const root = join(base, "collections");
  execFileSync("git", ["init", "-q", root]);
  const cwd = process.cwd();
  process.chdir(base);
  try {
    const out = { write: () => true } as unknown as NodeJS.WritableStream;
    const code = await main(["install-hook", "--repo", "collections"], { STEELE_CONFIG_PATH: "config", STEELE_COLLECTIONS_CHECKPOINT: "state/c.json", STEELE_INDEX_NAMESPACE: "ns" }, out, out);
    assert.equal(code, 0);
  } finally {
    process.chdir(cwd);
  }
  const env = readFileSync(join(root, ".git", "steele-collections.env"), "utf8");
  const { realpathSync } = await import("node:fs");
  const real = realpathSync(base);
  assert.ok(env.includes(`STEELE_CONFIG_PATH='${join(real, "config")}'`) || env.includes(`STEELE_CONFIG_PATH='${join(base, "config")}'`), env);
  assert.ok(env.includes("state/c.json'") && !env.includes("STEELE_COLLECTIONS_CHECKPOINT='state/"), env);
  assert.match(env, /STEELE_INDEX_NAMESPACE='ns'/);
});

test("CLI exit codes: bad options and invalid settings are 2 (review on #957)", async () => {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  assert.equal(await main(["reconcile", "--unknown"], {}, sink(), sink()), 2);
  assert.equal(await main(["install-hook", "--repo"], {}, sink(), sink()), 2);
  const config = mkdtempSync(join(tmpdir(), "cfg-"));
  assert.equal(await main(["reconcile"], { STEELE_CONFIG_PATH: config, STEELE_COLLECTIONS_ROOT: config, STEELE_COLLECTIONS_CHECKPOINT: join(config, "c.json"), STEELE_INDEX_NAMESPACE: "UPPER" }, sink(), sink()), 2);
});

test("a failure to read the lock owner never counts as abandonment (review on #957)", async () => {
  const { withLock, LOCK_REF } = await import("../src/collections/lock.js");
  const root = mkdtempSync(join(tmpdir(), "lock-"));
  execFileSync("git", ["init", "-q", "--bare", root]);
  const repo = new GitRepository(root);
  const live = await repo.writeBlob(JSON.stringify({ host: "h", pid: 1, token: "x", at: 0 }));
  await repo.swapRef(LOCK_REF, live, null);
  const contender = new GitRepository(root);
  const { GitError } = await import("../src/common/git/index.js");
  contender.readBlob = async () => {
    throw new GitError("timeout", "cat-file");
  };
  await assert.rejects(withLock(contender, async () => "stolen", { pollMs: 5, host: "h", isAlive: () => false }), (e: unknown) => e instanceof GitError && e.code === "timeout");
  assert.equal(await repo.readRef(LOCK_REF), live, "the owner keeps its lock");
});
