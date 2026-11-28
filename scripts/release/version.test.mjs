// Tests for the release version allocator (#959). Run: node --test scripts/release/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BASELINE_PATH, bump, classify, versionAt, versionFor } from "./version.mjs";

test("bump classes from messages; patch by default", () => {
  assert.equal(classify(["Document the runbook"]), "patch");
  assert.equal(classify(["Add a thing\n\nSemver: minor"]), "minor");
  assert.equal(classify(["feat(feeds): poll"]), "minor");
  assert.equal(classify(["refactor!: new contract"]), "major");
  assert.deepEqual(bump([0, 3, 4], "major"), [0, 4, 0], "breaking is minor before 1.0");
  assert.equal(versionFor(["patch", "minor", "patch"], [0, 2, 0]), "0.3.1");
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "release-version-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env }).trim();
  git("init", "-q", "-b", "main");
  const commit = (message, files = {}) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit };
}

test("the new baseline starts at its declared version and ignores the archived baseline", () => {
  const r = repo();
  r.commit("archived pipeline", { "scripts/release/BASELINE": "old" });
  r.commit("archived change");
  const base = r.commit("Start rebuilt releases", { [BASELINE_PATH]: JSON.stringify({ version: "0.2.0" }) });
  assert.equal(versionAt(base, r.dir), "0.2.0");
  const a = r.commit("Fix a thing");
  const b = r.commit("feat: add a thing");
  const c = r.commit("Document it");
  assert.deepEqual([a, b, c].map((s) => versionAt(s, r.dir)), ["0.2.1", "0.3.0", "0.3.1"]);
});

test("the same commit always gets the same version, and later commits never reuse one", () => {
  const r = repo();
  r.commit("base", { [BASELINE_PATH]: JSON.stringify({ version: "0.2.0" }) });
  const shas = ["one", "feat: two", "three", "x!: four", "five"].map((m) => r.commit(m));
  const versions = shas.map((s) => versionAt(s, r.dir));
  assert.equal(new Set(versions).size, versions.length, "distinct versions");
  assert.deepEqual(shas.map((s) => versionAt(s, r.dir)), versions, "reruns agree");
  // A later commit on main does not change an earlier commit's version.
  r.commit("six");
  assert.deepEqual(shas.map((s) => versionAt(s, r.dir)), versions);
});

test("a commit before the baseline has no version", () => {
  const r = repo();
  const early = r.commit("before");
  r.commit("base", { [BASELINE_PATH]: JSON.stringify({ version: "0.2.0" }) });
  assert.throws(() => versionAt(early, r.dir), /no release baseline/);
});

test("the declared baseline is above every historical tag in this repository", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseVersion } = await import("./version.mjs");
  const base = parseVersion(JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8")).version);
  const tags = execFileSync("git", ["tag", "-l", "v[0-9]*"], { encoding: "utf8" })
    .split("\n")
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1).split(".").map(Number));
  const below = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  for (const tag of tags) assert.ok(below(tag, base), `v${tag.join(".")} must be below the baseline`);
});
