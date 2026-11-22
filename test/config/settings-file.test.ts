import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { savedFileVersion, SETTINGS } from "../../src/config/settings.js";
import {
  listSettingsRevisions,
  readSettingsFile,
  restoreSettingsRevision,
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
      expectedVersion: savedFileVersion({}, salt),
      changes: { [secretKey]: "x" },
      env,
      salt,
      now,
    });
    expect(result.decision).toMatchObject({ status: "rejected", reason: "not-editable" });
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("validates against the file on disk, not a caller snapshot", async () => {
    await writeFile(path, JSON.stringify({ [publicKey]: "1" }), { mode: 0o600 });
    // Caller claims to have seen the empty version; disk says otherwise.
    const result = await saveSettings(path, {
      expectedVersion: savedFileVersion({}, salt),
      changes: { [publicKey]: "2" },
      env,
      salt,
      now,
    });
    expect(result.decision).toMatchObject({ status: "rejected", reason: "stale-version" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ [publicKey]: "1" });
  });

  it("serialises overlapping saves so only one wins", async () => {
    const expected = savedFileVersion({}, salt);
    const [a, b] = await Promise.all([
      saveSettings(path, { expectedVersion: expected, changes: { [publicKey]: "1" }, env, salt, now }),
      saveSettings(path, { expectedVersion: expected, changes: { [publicKey]: "2" }, env, salt, now }),
    ]);
    const accepted = [a, b].filter((r) => r.decision.status === "accepted");
    expect(accepted).toHaveLength(1);
    expect([a, b].filter((r) => r.decision.status !== "accepted")).toHaveLength(1);
  });

  it("reports an unreadable or invalid existing file instead of overwriting it", async () => {
    await writeFile(path, "{not json");
    await expect(readSettingsFile(path)).rejects.toBeInstanceOf(SettingsFileError);
    await writeFile(path, JSON.stringify({ key: 5 }));
    await expect(readSettingsFile(path)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("configuration revision history and restore (#545)", () => {
  it("retains the replaced revision and restores it explicitly", async () => {
    const expected = savedFileVersion({}, salt);
    await saveSettings(path, { expectedVersion: expected, changes: { [publicKey]: "1" }, env, salt, now });
    const afterFirst = savedFileVersion({ [publicKey]: "1" }, salt);
    expect(await listSettingsRevisions(path)).toContain(`${expected}.json`);

    await saveSettings(path, {
      expectedVersion: afterFirst,
      changes: { [publicKey]: "2" },
      env,
      salt,
      now,
    });
    expect(await listSettingsRevisions(path)).toContain(`${afterFirst}.json`);

    // Restore the first saved state, presenting the version now on disk.
    const restored = await restoreSettingsRevision(path, {
      version: afterFirst,
      expectedVersion: savedFileVersion({ [publicKey]: "2" }, salt),
      salt,
      now,
    });
    expect(restored).toMatchObject({ status: "restored", version: afterFirst });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ [publicKey]: "1" });
    expect(await readFile(`${path}.audit.log`, "utf8")).toMatch(/restore\t/);
  });

  it("refuses a restore over a configuration the operator never saw", async () => {
    await saveSettings(path, {
      expectedVersion: savedFileVersion({}, salt),
      changes: { [publicKey]: "1" },
      env,
      salt,
      now,
    });
    const restored = await restoreSettingsRevision(path, {
      version: savedFileVersion({}, salt),
      expectedVersion: savedFileVersion({ [publicKey]: "9" }, salt),
      salt,
      now,
    });
    expect(restored).toMatchObject({ status: "rejected", reason: "stale-version" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ [publicKey]: "1" });
  });

  it("refuses an unknown revision", async () => {
    const restored = await restoreSettingsRevision(path, {
      version: "config-file-sha256:" + "0".repeat(32),
      expectedVersion: savedFileVersion({}, salt),
      salt,
      now,
    });
    expect(restored).toMatchObject({ status: "rejected", reason: "unknown-revision" });
  });
});
