import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error -- plain ESM script without type declarations
import { bump, classify, versionFor } from "../../scripts/release/version.mjs";

describe("release version policy (#570)", () => {
  it("defaults every merge, including docs and chores, to a patch bump", () => {
    expect(classify({ title: "Document the runbook" })).toBe("patch");
    expect(classify({ title: "chore: tidy" })).toBe("patch");
    expect(versionFor([])).toBe("0.1.0");
    expect(versionFor(["patch", "patch"])).toBe("0.1.2");
  });

  it("uses explicit labels or conventional titles for larger bumps", () => {
    expect(classify({ labels: ["semver:minor"], title: "Anything" })).toBe("minor");
    expect(classify({ title: "feat(research): one request per theme" })).toBe("minor");
    expect(classify({ labels: ["semver:major"] })).toBe("major");
    expect(classify({ title: "refactor!: new contract" })).toBe("major");
    expect(versionFor(["patch", "minor", "patch"])).toBe("0.2.1");
  });

  it("treats breaking changes as minor before 1.0 (recorded policy)", () => {
    expect(bump([0, 3, 4], "major")).toEqual([0, 4, 0]);
    expect(bump([1, 3, 4], "major")).toEqual([2, 0, 0]);
  });

  it("gives successive commits strictly increasing, distinct versions", () => {
    const kinds = ["patch", "minor", "major", "patch", "patch"];
    const versions = kinds.map((_, i) => versionFor(kinds.slice(0, i + 1)));
    expect(new Set(versions).size).toBe(versions.length);
    const key = (v: string) => v.split(".").map(Number);
    for (let i = 1; i < versions.length; i++) {
      const [a, b] = [key(versions[i - 1]!), key(versions[i]!)];
      expect(
        a[0]! < b[0]! || (a[0] === b[0] && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! < b[2]!))),
      ).toBe(true);
    }
    // The same history always yields the same version (reruns agree).
    expect(versionFor(kinds)).toBe(versionFor([...kinds]));
  });
});

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("release version from first-parent history (#570)", () => {
  it("starts at the baseline commit and bumps each later commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "release-version-"));
    const git = (...a: string[]) =>
      execFileSync("git", a, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
      }).trim();
    const script = resolve("scripts/release/version.mjs");
    const version = (sha: string) =>
      execFileSync("node", [script, sha], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, GH_TOKEN: "" },
      }).trim();
    try {
      git("init", "-q", "-b", "main");
      await writeFile(join(dir, "a"), "1");
      git("add", "a");
      git("commit", "-qm", "before versioning");
      await mkdir(join(dir, "scripts/release"), { recursive: true });
      await writeFile(join(dir, "scripts/release/BASELINE"), "x");
      git("add", ".");
      git("commit", "-qm", "Add release baseline");
      const base = git("rev-parse", "HEAD");
      await writeFile(join(dir, "a"), "2");
      git("commit", "-qam", "Document things");
      const docs = git("rev-parse", "HEAD");
      await writeFile(join(dir, "a"), "3");
      git("commit", "-qam", "feat: a feature");
      const feat = git("rev-parse", "HEAD");
      expect(version(base)).toBe("0.1.0");
      expect(version(docs)).toBe("0.1.1");
      expect(version(feat)).toBe("0.2.0");
      // Rerunning an older commit after newer ones exist keeps its version.
      expect(version(docs)).toBe("0.1.1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
