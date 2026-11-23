import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { inspectSettings, resolveSettings, savedFileVersion, SETTINGS } from "../../src/config/settings.js";
import { configEditAction, editsFromForm } from "../../src/dashboard/config-edit.js";
import { renderConfigForm } from "../../src/dashboard/config-view.js";
import { listSettingsRevisions, saveSettings } from "../../src/config/settings-file.js";

// Synthetic values only.
const salt = "synthetic-salt";
const publicKey = SETTINGS.find((s) => s.sensitivity === "public")!.key;
const secretKey = SETTINGS.find((s) => s.sensitivity !== "public")!.key;
const now = () => new Date("2026-02-01T00:00:00.000Z");

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-config-edit-"));
  path = join(dir, "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const form = (fields: Record<string, string>) => new URLSearchParams(fields);

describe("console configuration edit (#545)", () => {
  it("saves an edited public setting and redirects", async () => {
    const action = configEditAction({ path, salt, now });
    const result = await action.submit(
      form({ action: "save", version: savedFileVersion({}, salt), [`k.${publicKey}`]: "1" }),
    );
    expect(result).toEqual({ status: 303, location: "/config" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ [publicKey]: "1" });
  });

  it("refuses a non-public setting instead of silently dropping it", async () => {
    const action = configEditAction({ path, salt, now });
    const result = await action.submit(
      form({ action: "save", version: savedFileVersion({}, salt), [`k.${secretKey}`]: "x" }),
    );
    expect(result).toMatchObject({ status: 400, reason: "not-editable" });
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("refuses a stale submission", async () => {
    await writeFile(path, JSON.stringify({ [publicKey]: "1" }), { mode: 0o600 });
    const action = configEditAction({ path, salt, now });
    const result = await action.submit(
      form({ action: "save", version: savedFileVersion({}, salt), [`k.${publicKey}`]: "2" }),
    );
    expect(result).toMatchObject({ status: 409, reason: "stale-version" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ [publicKey]: "1" });
  });

  it("restores a retained revision", async () => {
    await saveSettings(path, { expectedVersion: savedFileVersion({}, salt), changes: { [publicKey]: "1" }, env: {}, salt, now });
    const first = savedFileVersion({ [publicKey]: "1" }, salt);
    await saveSettings(path, { expectedVersion: first, changes: { [publicKey]: "2" }, env: {}, salt, now });
    const current = savedFileVersion({ [publicKey]: "2" }, salt);
    expect(await listSettingsRevisions(path)).toContain(`${first}.json`);

    const action = configEditAction({ path, salt, now });
    const result = await action.submit(form({ action: "restore", version: current, restoreVersion: first }));
    expect(result).toEqual({ status: 303, location: "/config" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ [publicKey]: "1" });
  });

  it("rejects malformed or empty requests", async () => {
    const action = configEditAction({ path, salt, now });
    expect((await action.submit(form({ action: "save", version: "nope" }))).status).toBe(400);
    expect((await action.submit(form({ action: "save", version: savedFileVersion({}, salt) }))).status).toBe(400);
    expect((await action.submit(form({ action: "restore", version: savedFileVersion({}, salt) }))).status).toBe(400);
  });

  it("renders inputs only for public settings, with the saved version", () => {
    const html = renderConfigForm(inspectSettings(resolveSettings({} as NodeJS.ProcessEnv)), "config-file-sha256:" + "a".repeat(32));
    expect(html).toContain(`name="k.${publicKey}"`);
    expect(html).not.toContain(`name="k.${secretKey}"`);
    expect(html).toContain(`value="config-file-sha256:${"a".repeat(32)}"`);
    expect(html).toContain('action="/config/save"');
  });
});

describe("form parsing", () => {
  it("takes only prefixed keys", () => {
    expect(editsFromForm(form({ version: "v", [`k.${publicKey}`]: "1" }))).toEqual({ [publicKey]: "1" });
  });
});
