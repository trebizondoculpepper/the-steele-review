#!/usr/bin/env node
/**
 * Release version for one main commit (#959; ported from the archived #570 policy).
 *
 * The version is a pure function of main's first-parent Git history, so a
 * rerun or a concurrent run of the same commit always gets the same version
 * and two commits never share one. No network or mutable metadata is used.
 *
 * - The first-parent commit that most recently added `scripts/release/baseline.json`
 *   has the version that file declares (0.2.0). The archived pipeline's own
 *   baseline (scripts/release/BASELINE, v0.1.x) is ignored: its tags must never
 *   be reissued.
 * - Every later first-parent commit bumps the version by its class, read from
 *   its own message and, for a merge commit, the messages it brought in:
 *   - major: a `Semver: major` trailer or a `type!:` subject (before 1.0 this
 *     bumps MINOR: pre-1.0 policy, breaking changes are minor);
 *   - minor: a `Semver: minor` trailer or a `feat:` subject;
 *   - patch: everything else.
 *
 * Usage: node scripts/release/version.mjs <sha>   (needs full history)
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const BASELINE_PATH = "scripts/release/baseline.json";

export function classify(messages) {
  const lines = messages.flatMap((m) => m.split("\n").map((l) => l.trim()));
  if (lines.some((l) => /^semver:\s*major$/i.test(l) || /^[a-z]+(\([^)]*\))?!:/i.test(l))) return "major";
  if (lines.some((l) => /^semver:\s*minor$/i.test(l) || /^feat(\([^)]*\))?:/i.test(l))) return "minor";
  return "patch";
}

export function bump([major, minor, patch], kind) {
  if (kind === "major") return major === 0 ? [0, minor + 1, 0] : [major + 1, 0, 0];
  if (kind === "minor") return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  if (!m) throw new Error("baseline version must be MAJOR.MINOR.PATCH");
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function versionFor(kinds, base) {
  return kinds.reduce(bump, base).join(".");
}

export function versionAt(sha, cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", cwd }).trim();
  const baseline = git("log", "--first-parent", "--diff-filter=A", "--format=%H", sha, "--", BASELINE_PATH)
    .split("\n")
    .filter(Boolean)[0];
  if (!baseline) throw new Error("no release baseline in this commit's history");
  const base = parseVersion(JSON.parse(git("show", `${baseline}:${BASELINE_PATH}`)).version);
  const after = git("rev-list", "--first-parent", "--reverse", `${baseline}..${sha}`).split("\n").filter(Boolean);
  const messagesOf = (commit) => {
    const own = git("log", "-1", "--format=%B", commit);
    const parents = git("rev-list", "--parents", "-n", "1", commit).split(" ").slice(1);
    if (parents.length < 2) return [own];
    const branch = git("log", "--format=%B%x00", `${parents[0]}..${parents[1]}`).split("\0").filter((m) => m.trim());
    return [own, ...branch];
  };
  return versionFor(after.map((c) => classify(messagesOf(c))), base);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const sha = process.argv[2];
  if (!sha) {
    console.error("usage: version.mjs <sha>");
    process.exit(2);
  }
  console.log(versionAt(sha));
}
