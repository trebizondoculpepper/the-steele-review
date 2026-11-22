import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vite-plus/test";

it("rejects malformed recovery flags and job selections before state writes or network submission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "article-cli-recovery-")),
    state = join(dir, "never.sqlite"),
    file = join(dir, "invalid.json");
  await writeFile(file, JSON.stringify(["not-a-research-id"]));
  try {
    const cases = [
      ["--request-id", "request", "--editorial-revisions", "1"],
      ["--request-id", "request", "--editorial-deadline-ms", "120000"],
      ["--recovery-generation", "0", "--request-id", "request"],
      ["--recovery-generation", "101", "--request-id", "request"],
      ["--recovery-generation", "invalid", "--request-id", "request"],
      ["--recovery-generation", "1"],
      ["--retained-research-file", file, "--request-id", "request"],
      ["--recovery-generation", "1", "--request-id", "request", "--retained-research-file", file],
    ];
    for (const args of cases) {
      const out = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("src/cli/article-run.ts"),
          "--publication-id",
          "fixture",
          "--post-id",
          "post",
          ...args,
        ],
        {
          cwd: process.cwd(),
          timeout: 10_000,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            STEELE_STATE_PATH: state,
            STEELE_ARCHIVE_PATH: join(dir, "not-created"),
            STEELE_ARCHIVE_REPOSITORY: "archive",
            RESTATE_INGRESS_URL: "https://unreachable.example",
          },
        },
      );
      expect(out.status).toBe(2);
      expect(out.stdout).toBe("");
      expect(out.stderr).not.toContain(dir);
      expect(existsSync(state)).toBe(false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
