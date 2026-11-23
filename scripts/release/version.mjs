#!/usr/bin/env node
/**
 * Release version for one main commit (#570).
 *
 * The version is a pure function of main's first-parent history, so reruns
 * and concurrent runs always agree and never allocate the same version twice:
 *
 * - The commit that adds `scripts/release/BASELINE` is v0.1.0.
 * - Every later first-parent commit bumps the version by its class:
 *   - "major": a `semver:major` PR label or a conventional `type!:` title.
 *     Before 1.0 this bumps MINOR (pre-1.0 policy: breaking changes are minor).
 *   - "minor": a `semver:minor` PR label or a conventional `feat:` title.
 *   - "patch": everything else, including docs and chore merges.
 *
 * Usage: node scripts/release/version.mjs <sha>
 * Prints `0.x.y`. Needs git history (fetch-depth 0); `gh` is used to read
 * each commit's PR labels and title when GH_TOKEN is set.
 */
import { execFileSync } from "node:child_process";

export const BASELINE_PATH = "scripts/release/BASELINE";

/** The bump class of one commit from its PR labels and title. */
export function classify({ labels = [], title = "" }) {
  if (labels.includes("semver:major") || /^[a-z]+(\([^)]*\))?!:/i.test(title)) return "major";
  if (labels.includes("semver:minor") || /^feat(\([^)]*\))?:/i.test(title)) return "minor";
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

function prOf(sha) {
  if (!process.env.GH_TOKEN) return {};
  try {
    const raw = execFileSync(
      "gh",
      [
        "api",
        `repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`,
        "--jq",
        ".[0] | {title, labels: [.labels[].name]}",
      ],
      { encoding: "utf8" },
    ).trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
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
  const kinds = after.map((c) => {
    const pr = prOf(c);
    // A merge commit's own subject is "Merge pull request ..."; the PR title
    // classifies it. A direct commit uses its subject.
    return classify({
      labels: pr.labels ?? [],
      title: pr.title ?? git("log", "-1", "--format=%s", c),
    });
  });
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
