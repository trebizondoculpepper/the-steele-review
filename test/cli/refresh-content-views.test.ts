import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

// #420: the content-view refresh command against real temporary repositories.
const CLI = ["--import", "tsx", join(process.cwd(), "src/cli/refresh-content-views.ts")];
let dir: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();

/** A bare "authoritative" repository with one commit, plus a browsable clone. */
async function view(name: string) {
  const bare = join(dir, `${name}.git`);
  const seed = join(dir, `${name}-seed`);
  const checkout = join(dir, name);
  git(dir, "init", "--quiet", "--bare", "-b", "main", bare);
  git(dir, "clone", "--quiet", bare, seed);
  await writeFile(join(seed, "a.json"), "{}\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "first");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  git(dir, "clone", "--quiet", bare, checkout);
  /** Commit a new artifact upstream, as the artifact store would. */
  const commitUpstream = async (file: string) => {
    await writeFile(join(seed, file), `${file}\n`);
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", file);
    git(seed, "push", "--quiet", "origin", "HEAD:main");
    return git(seed, "rev-parse", "HEAD");
  };
  return { checkout, commitUpstream };
}

const statusDir = () => join(dir, "status");
const run = (...views: string[]) =>
  execFileSync(process.execPath, [...CLI, statusDir(), ...views], {
    encoding: "utf8",
    stdio: "pipe",
  });
/** Run and return combined stdout and stderr, whatever the exit code. */
const runAll = (...args: string[]) => {
  try {
    return execFileSync(process.execPath, [...CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
};
const read = async (name: string) =>
  JSON.parse(await readFile(join(statusDir(), `${name}.json`), "utf8")) as Record<string, string>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-refresh-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("refresh-content-views (#420)", { timeout: 60_000 }, () => {
  it("fast-forwards clean archive and content views to new commits", async () => {
    const archive = await view("archive");
    const content = await view("content");
    const a = await archive.commitUpstream("capture.json");
    const c = await content.commitUpstream("draft.md");
    run(`archive=${archive.checkout}`, `content=${content.checkout}`);
    expect(git(archive.checkout, "rev-parse", "HEAD")).toBe(a);
    expect(git(content.checkout, "rev-parse", "HEAD")).toBe(c);
    expect(await read("content")).toMatchObject({ view: "content", state: "fresh", revision: c });
    expect((await read("content")).lastSuccessAt).toBeTruthy();
    run(`content=${content.checkout}`);
    expect(await read("content")).toMatchObject({ state: "fresh", revision: c });
  });

  it("never touches local edits, untracked files or divergent history, and reports them", async () => {
    const content = await view("content");
    const before = git(content.checkout, "rev-parse", "HEAD");
    await content.commitUpstream("draft.md");
    await writeFile(join(content.checkout, "notes.txt"), "my notes\n");
    run(`content=${content.checkout}`);
    expect(git(content.checkout, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(content.checkout, "notes.txt"), "utf8")).toBe("my notes\n");
    expect(await read("content")).toMatchObject({ state: "stale", reason: "local-changes" });

    git(content.checkout, "add", ".");
    git(content.checkout, "commit", "--quiet", "-m", "local");
    const local = git(content.checkout, "rev-parse", "HEAD");
    run(`content=${content.checkout}`);
    expect(git(content.checkout, "rev-parse", "HEAD")).toBe(local);
    expect(await read("content")).toMatchObject({ state: "stale", reason: "diverged" });
  });

  it("never overwrites an ignored local file that upstream starts tracking", async () => {
    const content = await view("content");
    await writeFile(join(content.checkout, ".git", "info", "exclude"), "local.md\n");
    await writeFile(join(content.checkout, "local.md"), "my private notes\n");
    await content.commitUpstream("local.md");
    run(`content=${content.checkout}`);
    expect(await readFile(join(content.checkout, "local.md"), "utf8")).toBe("my private notes\n");
    expect(await read("content")).toMatchObject({ state: "stale", reason: "fast-forward-failed" });
  });

  it("keeps private paths out of its output for a missing checkout or status directory", async () => {
    const missing = join(dir, "private-account", "nowhere");
    const out = runAll(statusDir(), `content=${missing}`);
    expect(out).not.toContain("private-account");
    expect(await read("content")).toMatchObject({ state: "stale", reason: "not-a-checkout" });

    await writeFile(join(dir, "secret-home"), "a file, not a directory");
    const bad = runAll(join(dir, "secret-home", "status"), "content=/nowhere");
    expect(bad).toContain("status-dir-unavailable");
    expect(bad).not.toContain("secret-home");
  });

  it("leaves a live owner's lock alone and takes over only a dead owner's lock", async () => {
    const content = await view("content");
    const before = git(content.checkout, "rev-parse", "HEAD");
    const next = await content.commitUpstream("draft.md");
    await mkdir(statusDir(), { recursive: true });
    const lock = join(statusDir(), ".refresh.lock");
    // A live owner (this test process) on this host: never taken over, whatever its age.
    await writeFile(lock, JSON.stringify({ host: hostname(), pid: process.pid }));
    run(`content=${content.checkout}`);
    expect(git(content.checkout, "rev-parse", "HEAD")).toBe(before);
    // A dead owner: its lock is taken over and the refresh runs.
    await writeFile(lock, JSON.stringify({ host: hostname(), pid: 2 ** 22 + 12_345 }));
    run(`content=${content.checkout}`);
    expect(git(content.checkout, "rev-parse", "HEAD")).toBe(next);
    const raw = await readFile(join(statusDir(), "content.json"), "utf8");
    expect(raw).not.toContain(dir);
    expect(JSON.parse(raw)).toMatchObject({ state: "fresh" });
  });
});
