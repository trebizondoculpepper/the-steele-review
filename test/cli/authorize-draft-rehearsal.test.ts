import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
const run = (args: string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli/authorize-draft-rehearsal.ts", ...args],
    { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
describe("owner draft operator arguments", () => {
  it("requires explicit command-line authority before reading input or configuration", () => {
    const result = run(["--input", "/synthetic/not-read.json", "--request-id", "one"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).not.toContain("/synthetic/not-read.json");
  });
  it("never propagates rejected input material into diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "owner-cli-")),
      file = join(dir, "request.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({ secretLikeExtra: "SYNTHETIC-REJECTED-MATERIAL", enable: true }),
      );
      const result = run(["--input", file, "--request-id", "one", "--owner-authorized-draft"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid-input");
      expect(result.stderr).not.toContain("SYNTHETIC-REJECTED-MATERIAL");
      expect(result.stderr).not.toContain(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
