import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

// #420: the content-view refresh script against real temporary repositories.
const SCRIPT = join(process.cwd(), "deploy/content-views/refresh-checkouts.sh");
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

const status = join("status");
const run = (...views: string[]) =>
  execFileSync("sh", [SCRIPT, join(dir, status), ...views], { encoding: "utf8", stdio: "pipe" });
const read = async (name: string) =>
  JSON.parse(await readFile(join(dir, status, `${name}.json`), "utf8")) as Record<string, string>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-refresh-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("refresh-checkouts.sh (#420)", { timeout: 60_000 }, () => {
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
    // Up to date: still fresh, nothing changes.
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

    // A local commit the remote does not have: diverged, left as is.
    git(content.checkout, "add", ".");
    git(content.checkout, "commit", "--quiet", "-m", "local");
    const local = git(content.checkout, "rev-parse", "HEAD");
    run(`content=${content.checkout}`);
    expect(git(content.checkout, "rev-parse", "HEAD")).toBe(local);
    expect(await read("content")).toMatchObject({ state: "stale", reason: "diverged" });
  });

  it("does nothing while another refresh holds the lock, and records no paths", async () => {
    const content = await view("content");
    const before = git(content.checkout, "rev-parse", "HEAD");
    await content.commitUpstream("draft.md");
    await mkdir(join(dir, status, ".refresh.lock"), { recursive: true });
    run(`content=${content.checkout}`);
    expect(git(content.checkout, "rev-parse", "HEAD")).toBe(before);
    await rm(join(dir, status, ".refresh.lock"), { recursive: true });
    run(`content=${content.checkout}`);
    const raw = await readFile(join(dir, status, "content.json"), "utf8");
    expect(raw).not.toContain(dir);
    expect(JSON.parse(raw)).toMatchObject({ state: "fresh" });
  });
});
