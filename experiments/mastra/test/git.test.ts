import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { executableGitRunner, GitError, GitRepository, sanitisedGitEnvironment, type GitRunner } from "../src/common/git/index.js";

function repo(bare = false) {
  const root = mkdtempSync(join(tmpdir(), "git-service-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main", ...(bare ? ["--bare"] : []));
  return { root, git, repo: new GitRepository(root) };
}

async function gitError(work: Promise<unknown>): Promise<GitError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof GitError, `expected GitError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a GitError");
}

test("commits records without a working tree, and reads them back at the exact revision", async () => {
  const { repo: r, git } = repo(true);
  assert.equal(await r.resolve("main"), null, "an unborn branch resolves to nothing");

  const first = await r.commit({
    parent: null,
    writes: [
      { path: "feeds/saveusnow/a.json", content: '{"title":"A"}' },
      { path: "feeds/saveusnow/b.json", content: '{"title":"B"}' },
      { path: "research/collection.json", content: "{}" },
    ],
    message: "First poll",
  });
  assert.equal(first.changed, true);
  assert.equal(await r.resolve("main"), first.commit);
  assert.equal(git("log", "--format=%an <%ae>|%s", "main"), "steele-review <steele-review@invalid>|First poll");

  const second = await r.commit({ writes: [{ path: "feeds/saveusnow/a.json", content: '{"title":"A2"}' }], deletes: ["feeds/saveusnow/b.json"], message: "Second poll" });
  assert.equal(second.changed, true);

  assert.deepEqual(await r.listDirectories(second.commit!), ["feeds", "research"]);
  assert.deepEqual(await r.listDirectories(second.commit!, "feeds"), ["saveusnow"]);
  assert.deepEqual((await r.listFiles(first.commit!, "feeds")).map((e) => e.path), ["feeds/saveusnow/a.json", "feeds/saveusnow/b.json"]);
  assert.deepEqual((await r.listFiles(second.commit!)).map((e) => e.path), ["feeds/saveusnow/a.json", "research/collection.json"]);
  assert.equal((await r.readText(first.commit!, "feeds/saveusnow/a.json"))!.text, '{"title":"A"}');
  assert.equal((await r.readText(second.commit!, "feeds/saveusnow/a.json"))!.text, '{"title":"A2"}');
  assert.equal(await r.readFile(second.commit!, "feeds/saveusnow/b.json"), null, "absence is a result");
  assert.equal(await r.readFile(second.commit!, "feeds"), null, "a directory is not a file");
  const read = await r.readFile(first.commit!, "feeds/saveusnow/a.json");
  assert.equal(read!.blob, git("rev-parse", `${first.commit}:feeds/saveusnow/a.json`));

  assert.deepEqual(await r.compare(first.commit!, second.commit!), [
    { path: "feeds/saveusnow/a.json", change: "modified" },
    { path: "feeds/saveusnow/b.json", change: "deleted" },
  ]);
  assert.deepEqual(await r.compare(first.commit!, second.commit!, "research"), []);
  assert.equal(await r.isAncestor(first.commit!, second.commit!), true);
  assert.equal(await r.isAncestor(second.commit!, first.commit!), false);
  assert.equal(await r.isAncestor("0".repeat(40), second.commit!), false, "an unknown commit is not an ancestor");
});

test("repeating identical content makes no commit", async () => {
  const { repo: r, git } = repo(true);
  const first = await r.commit({ parent: null, writes: [{ path: "feeds/a.json", content: "x" }], message: "one" });
  const again = await r.commit({ writes: [{ path: "feeds/a.json", content: "x" }], message: "again" });
  assert.deepEqual(again, { commit: first.commit, changed: false });
  assert.equal(git("rev-list", "--count", "main"), "1");
});

test("a commit on a stale parent is a conflict and never loses the other writer's commit", async () => {
  const { repo: r } = repo(true);
  const base = await r.commit({ parent: null, writes: [{ path: "a.json", content: "1" }], message: "base" });
  const winner = await r.commit({ parent: base.commit, writes: [{ path: "b.json", content: "2" }], message: "winner" });
  const lost = await gitError(r.commit({ parent: base.commit, writes: [{ path: "c.json", content: "3" }], message: "loser" }));
  assert.equal(lost.code, "conflict");
  assert.equal(await r.resolve("main"), winner.commit);
  const fresh = await gitError(r.commit({ parent: null, writes: [{ path: "d.json", content: "4" }], message: "pretends empty" }));
  assert.equal(fresh.code, "conflict");
});

test("works on a non-bare repository and leaves its working tree alone", async () => {
  const { root, repo: r, git } = repo();
  mkdirSync(join(root, "feeds"));
  writeFileSync(join(root, "feeds", "draft.json"), "uncommitted");
  const result = await r.commit({ parent: null, writes: [{ path: "feeds/a.json", content: "{}" }], message: "add" });
  const { readFileSync, existsSync } = await import("node:fs");
  assert.equal(readFileSync(join(root, "feeds", "draft.json"), "utf8"), "uncommitted", "an uncommitted file is untouched");
  assert.equal(existsSync(join(root, "feeds", "a.json")), false, "the commit is not checked out into the working tree");
  assert.equal(git("rev-parse", "main"), result.commit);
  assert.deepEqual((await r.listFiles(result.commit!)).map((e) => e.path), ["feeds/a.json"], "uncommitted files are invisible");
});

test("paths and revisions that could escape the repository or act as options are refused", async () => {
  const { repo: r } = repo(true);
  for (const path of ["../x", "/etc/passwd", "a/../b", ".git/config", "a/.GIT/x", "a//b", "a\\b", "", "./a"])
    assert.equal((await gitError(r.commit({ parent: null, writes: [{ path, content: "" }], message: "m" }))).code, "invalid-path", path);
  assert.equal((await gitError(r.commit({ parent: null, writes: [{ path: "a", content: "" }], deletes: ["a"], message: "m" }))).code, "invalid-path");
  assert.equal((await gitError(r.commit({ branch: "-x", parent: null, message: "m" }))).code, "invalid-path");
  assert.equal((await gitError(r.readFile("--output=/tmp/x", "a"))).code, "invalid-path");
  assert.equal((await gitError(r.compare("HEAD", "main:a"))).code, "invalid-path");
});

test("a missing directory or a plain directory is not-a-repository, without the path in the message", async () => {
  const missing = join(tmpdir(), `no-such-repository-${process.pid}`);
  for (const root of [missing, mkdtempSync(join(tmpdir(), "plain-"))]) {
    const error = await gitError(new GitRepository(root).resolve());
    assert.equal(error.code, "not-a-repository");
    assert.doesNotMatch(error.message, /no-such-repository|plain-/);
  }
});

test("inherited Git location variables cannot redirect a call to another repository", async () => {
  const a = repo(true);
  const b = repo(true);
  await a.repo.commit({ parent: null, writes: [{ path: "a.json", content: "a" }], message: "a" });
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = a.root;
  try {
    assert.equal(await b.repo.resolve("main"), null, "B is still read, not the repository GIT_DIR names");
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
  const env = sanitisedGitEnvironment({ GIT_DIR: "/x", GIT_INDEX_FILE: "/y", GIT_CONFIG_KEY_0: "k", GIT_CONFIG_VALUE_0: "v", PATH: "/bin" });
  assert.deepEqual(Object.keys(env).sort(), ["GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "LC_ALL", "PATH"]);
});

test("cancellation and timeouts are reported as such", async () => {
  const { root } = repo(true);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await gitError(new GitRepository(root).resolve("main", controller.signal))).code, "cancelled");
  const slow: GitRunner = (r, args, options) => executableGitRunner({ timeoutMs: 1, binary: "sleep" })(r, ["5"], options);
  assert.equal((await gitError(new GitRepository(root, { runner: slow }).check())).code, "timeout");
});

test("callers depend only on typed operations: an injected runner sees every Git invocation", async () => {
  const { root } = repo(true);
  const seen: string[] = [];
  const real = executableGitRunner();
  const observing: GitRunner = (r, args, options) => {
    seen.push(args[0]!);
    return real(r, args, options);
  };
  const r = new GitRepository(root, { runner: observing });
  await r.commit({ parent: null, writes: [{ path: "a.json", content: "{}" }], message: "m" });
  assert.deepEqual(seen, ["read-tree", "hash-object", "update-index", "write-tree", "commit-tree", "update-ref"]);
});
