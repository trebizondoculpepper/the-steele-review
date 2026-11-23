#!/usr/bin/env node
/**
 * Release version for one main commit (#570).
 *
 * The version is a pure function of main's Git history only. No mutable PR
 * metadata and no network call is involved, so a rerun or a concurrent run of
 * the same commit always gets the same version, and two commits never share one:
 *
 * - The commit that adds `scripts/release/BASELINE` is v0.1.0.
 * - Every later first-parent commit bumps the version by its class, read from
 *   its own message (for a PR merge this includes the PR title) and from the
 *   messages of the commits the merge brought in:
 *   - "major": a `Semver: major` trailer or a conventional `type!:` subject.
 *     Before 1.0 this bumps MINOR (pre-1.0 policy: breaking changes are minor).
 *   - "minor": a `Semver: minor` trailer or a conventional `feat:` subject.
 *   - "patch": everything else, including docs and chore merges.
 *
 * Usage: node scripts/release/version.mjs <sha>   (needs full history)
 */
import { execFileSync } from "node:child_process";

export const BASELINE_PATH = "scripts/release/BASELINE";

/** The bump class of one commit from the messages it brings to main. */
export function classify(messages) {
  const lines = messages.flatMap((m) => m.split("\n").map((l) => l.trim()));
  if (lines.some((l) => /^semver:\s*major$/i.test(l) || /^[a-z]+(\([^)]*\))?!:/i.test(l)))
    return "major";
  if (lines.some((l) => /^semver:\s*minor$/i.test(l) || /^feat(\([^)]*\))?:/i.test(l)))
    return "minor";
  return "patch";
}

/** Applies one bump; before 1.0 a breaking change bumps minor (recorded policy). */
export function bump([major, minor, patch], kind) {
  if (kind === "major") return major === 0 ? [0, minor + 1, 0] : [major + 1, 0, 0];
  if (kind === "minor") return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

/** Folds the bumps of every commit after the baseline, in order. */
export function versionFor(kinds, base = [0, 1, 0]) {
  return kinds.reduce(bump, base).join(".");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** Every message a first-parent commit brings: its own, plus a merge's branch commits. */
function messagesOf(commit) {
  const own = git("log", "-1", "--format=%B", commit);
  const parents = git("rev-list", "--parents", "-n", "1", commit).split(" ").slice(1);
  if (parents.length < 2) return [own];
  const branch = git("log", "--format=%B%x00", `${parents[0]}..${parents[1]}`)
    .split("\0")
    .filter((m) => m.trim());
  return [own, ...branch];
}

function main(sha) {
  const baseline = git(
    "log",
    "--first-parent",
    "--diff-filter=A",
    "--format=%H",
    sha,
    "--",
    BASELINE_PATH,
  )
    .split("\n")
    .filter(Boolean)
    .at(-1);
  if (!baseline) throw new Error("no release baseline in this commit's history");
  const after = git("rev-list", "--first-parent", "--reverse", `${baseline}..${sha}`)
    .split("\n")
    .filter(Boolean);
  const kinds = after.map((c) => classify(messagesOf(c)));
  return versionFor(kinds);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sha = process.argv[2];
  if (!sha) {
    console.error("usage: version.mjs <sha>");
    process.exit(2);
  }
  console.log(main(sha));
}
