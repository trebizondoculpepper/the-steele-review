import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore, WAKE_SIGNAL } from "../../src/controllers/artifact-store.js";

let dir: string;
let store: GitArtifactStore;
const gitDir = () =>
  execFileSync("git", ["-C", dir, "rev-parse", "--absolute-git-dir"]).toString().trim();
const signalTime = async () => {
  try {
    return (await stat(join(gitDir(), WAKE_SIGNAL))).mtimeMs;
  } catch {
    return undefined;
  }
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-wake-hook-"));
  store = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await store.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Git wake hook (#251)", () => {
  it("signals committed updates, and the watcher wakes", async () => {
    expect(await store.installWakeHook()).toBe("installed");
    let wakes = 0;
    const watcher = await store.watchBranch(() => wakes++);
    await store.revise("dossier/a.md", "# A\n", null);
    expect(await signalTime()).toBeDefined();
    await new Promise((r) => setTimeout(r, 300));
    watcher.close();
    expect(wakes).toBeGreaterThan(0);
  });

  it("keeps the hook minimal: no branch filtering in shell", async () => {
    const { wakeHookScript } = await import("../../src/controllers/artifact-store.js");
    expect(wakeHookScript()).not.toMatch(/refs\/heads|while read/);
  });

  it("is idempotent and never replaces someone else's hook", async () => {
    expect(await store.installWakeHook()).toBe("installed");
    expect(await store.installWakeHook()).toBe("unchanged");
    const hooks = execFileSync("git", ["-C", dir, "rev-parse", "--git-path", "hooks"])
      .toString()
      .trim();
    const path = join(hooks.startsWith("/") ? hooks : join(dir, hooks), "reference-transaction");
    await writeFile(path, "#!/bin/sh\necho custom\n");
    expect(await store.installWakeHook()).toBe("foreign-hook");
    expect(await readFile(path, "utf8")).toContain("custom");
  });

  it("repeated signals for several commits are harmless: each wakes the same idempotent pass", async () => {
    await store.installWakeHook();
    let wakes = 0;
    const watcher = await store.watchBranch(() => wakes++);
    await store.revise("dossier/a.md", "# A1\n", null);
    const a = (await store.lookup("dossier/a.md"))!;
    await store.revise("dossier/a.md", "# A2\n", a.sha256);
    await new Promise((r) => setTimeout(r, 300));
    watcher.close();
    expect(wakes).toBeGreaterThanOrEqual(1);
  });
});
