import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vite-plus/test";
it("rejects invalid continuation flags and seed files before state or network work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-cli-"));
  const state = join(dir, "never.sqlite"),
    file = join(dir, "invalid.json");
  await writeFile(file, JSON.stringify({ secret: "synthetic-sensitive-marker" }));
  try {
    for (const args of [
      [],
      ["--request-id", "bad/id"],
      ["--wait-ms", "0"],
      ["--wait-ms", "3600001"],
      ["--unknown"],
      ["--input", file, "--request-id", "valid"],
    ]) {
      const out = spawnSync(
        process.execPath,
        ["--import", "tsx", resolve("src/cli/editorial-continue.ts"), ...args],
        {
          cwd: process.cwd(),
          timeout: 10_000,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            STEELE_STATE_PATH: state,
            RESTATE_INGRESS_URL: "https://unreachable.example.invalid",
          },
        },
      );
      expect(out.status).toBe(2);
      expect(out.stdout + out.stderr).not.toContain("synthetic-sensitive-marker");
      expect(existsSync(state)).toBe(false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
