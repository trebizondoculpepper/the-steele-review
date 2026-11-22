import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, expect } from "vite-plus/test";
it("rejects invalid selected publisher arguments/config before state or connection side effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "selected-publisher-cli-")),
    state = join(dir, "never.sqlite");
  try {
    for (const args of [
      [],
      ["--event-id", "bad/id", "--sequence", "1"],
      ["--event-id", "approved-a", "--sequence", "0"],
      ["--event-id", "approved-a", "--sequence", "not-a-number"],
      ["--event-id", "approved-a", "--sequence", "1", "--wait-ms", "0"],
      ["--unknown", "synthetic-sensitive-marker"],
      ["--event-id", "approved-a", "--sequence", "1"],
    ]) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", resolve("src/cli/substack-publisher-one.ts"), ...args],
        {
          timeout: 10000,
          encoding: "utf8",
          env: { PATH: process.env.PATH, STEELE_STATE_PATH: state },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stdout + result.stderr).not.toContain("synthetic-sensitive-marker");
      expect(existsSync(state)).toBe(false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
