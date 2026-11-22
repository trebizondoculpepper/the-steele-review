import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { savedFileVersion, SETTINGS } from "../../src/config/settings.js";
import {
  readSettingsFile,
  saveSettings,
  SettingsFileError,
} from "../../src/config/settings-file.js";

// Synthetic values only.
const salt = "synthetic-salt";
const publicKey = SETTINGS.find((s) => s.sensitivity === "public")!.key;
const env = {} as NodeJS.ProcessEnv;

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-settings-"));
  path = join(dir, "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const now = () => new Date("2026-02-01T00:00:00.000Z");

describe("configuration file save (#545)", () => {
  it("treats a missing file as empty and saves atomically", async () => {
    expect(await readSettingsFile(path)).toEqual({});
    const result = await saveSettings(path, {
      expectedVersion: savedFileVersion({}, salt),
      changes: { [publicKey]: "1" },
      env,
      salt,
      now,
    });
    expect(result.decision.status).toBe("accepted");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ [publicKey]: "1" });
    // The audit line is appended after the rename.
    expect(await readFile(`${path}.audit.log`, "utf8")).toMatch(/set\t/);
  });

  it("writes nothing when the submission is stale", async () => {
    await writeFile(path, JSON.stringify({ [publicKey]: "1" }), { mode: 0o600 });
    const before = await readFile(path, "utf8");
    const result = await saveSettings(path, {
      expectedVersion: savedFileVersion({}, salt),
      changes: { [publicKey]: "2" },
      env,
      salt,
      now,
    });
    expect(result.decision).toMatchObject({ status: "rejected", reason: "stale-version" });
    expect(await readFile(path, "utf8")).toBe(before);
    await expect(readFile(`${path}.audit.log`, "utf8")).rejects.toThrow();
  });

  it("refuses a non-editable setting without touching the file", async () => {
    const secretKey = SETTINGS.find((s) => s.sensitivity !== "public")!.key;
    const result = await saveSettings(path, {
      current: {},
      expectedVersion: savedFileVersion({}, salt),
      changes: { [secretKey]: "x" },
      env,
      salt,
      now,
    });
    expect(result.decision).toMatchObject({ status: "rejected", reason: "not-editable" });
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("reports an unreadable or invalid existing file instead of overwriting it", async () => {
    await writeFile(path, "{not json");
    await expect(readSettingsFile(path)).rejects.toBeInstanceOf(SettingsFileError);
    await writeFile(path, JSON.stringify({ key: 5 }));
    await expect(readSettingsFile(path)).rejects.toMatchObject({ code: "invalid" });
  });
});
