import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  ConfigurationController,
  ConfigurationError,
} from "../../src/controllers/configuration.js";

const SECRET = "sk-or-SENTINEL";
let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-config-"));
  file = join(dir, "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const roles = {
  "model-worker": ["STEELE_RESEARCH_MODEL", "STEELE_RESEARCH_REQUEST_LIMIT", "OPENROUTER_API_KEY"],
  dashboard: ["STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT"],
};
const controller = (env: Record<string, string> = {}) =>
  new ConfigurationController({ settingsFile: file, env, salt: "s", roles });

describe("configuration controller (#543)", () => {
  it("loads a valid snapshot through role-scoped views", async () => {
    await writeFile(file, JSON.stringify({ STEELE_RESEARCH_REQUEST_LIMIT: "3" }));
    const c = controller({ OPENROUTER_API_KEY: SECRET });
    const { version, file: state } = await c.load();
    expect(state).toBe("ok");
    const worker = c.runtime("model-worker");
    expect(worker.version).toBe(version);
    expect(worker.get("STEELE_RESEARCH_REQUEST_LIMIT")).toBe(3);
    expect(worker.get("OPENROUTER_API_KEY")).toBe(SECRET);
    // The dashboard role is not granted the provider credential.
    expect(() => c.runtime("dashboard").get("OPENROUTER_API_KEY")).toThrow(ConfigurationError);
    expect(() => c.runtime("publisher")).toThrow(ConfigurationError);
  });

  it("reports missing, invalid and unavailable files as fixed categories", async () => {
    expect((await controller().savedState()).file).toBe("missing");
    await writeFile(file, "{not json");
    const invalid = await controller().savedState();
    expect(invalid.file).toBe("invalid");
    expect(JSON.stringify(invalid)).not.toContain(dir);
    const unavailable = new ConfigurationController({
      settingsFile: file,
      env: {},
      salt: "s",
      roles,
      read: async () => {
        throw Object.assign(new Error(`EACCES ${file}`), { code: "EACCES" });
      },
    });
    const state = await unavailable.savedState();
    expect(state.file).toBe("unavailable");
    expect(JSON.stringify(state)).not.toContain(dir);
    // Invalid setting values inside a valid file are reported per setting.
    await writeFile(file, JSON.stringify({ STEELE_RESEARCH_REQUEST_LIMIT: "999" }));
    const bad = await controller().savedState();
    expect(bad.settings.find((s) => s.key === "STEELE_RESEARCH_REQUEST_LIMIT")?.state).toBe(
      "invalid",
    );
  });

  it("an external edit changes the saved version, not the active one, until loaded", async () => {
    await writeFile(file, JSON.stringify({ STEELE_RESEARCH_REQUEST_LIMIT: "2" }));
    const c = controller();
    const first = await c.load();
    await writeFile(file, JSON.stringify({ STEELE_RESEARCH_REQUEST_LIMIT: "4" }));
    const saved = await c.savedState();
    expect(saved.version).not.toBe(first.version);
    expect(c.activeVersion()).toBe(first.version);
    expect(c.runtime("model-worker").get("STEELE_RESEARCH_REQUEST_LIMIT")).toBe(2);
    c.acknowledge("article-worker", first.version);
    await c.load();
    expect(c.activeVersion()).toBe(saved.version);
    expect(c.runtime("model-worker").get("STEELE_RESEARCH_REQUEST_LIMIT")).toBe(4);
    // A component's acknowledgement is its own fact, not implied by the reload.
    expect(c.acknowledgements()).toMatchObject([
      { component: "article-worker", version: first.version },
    ]);
  });

  it("keeps existing environment precedence and never shows secrets in saved state", async () => {
    await writeFile(
      file,
      JSON.stringify({
        STEELE_RESEARCH_REQUEST_LIMIT: "2",
        OPENROUTER_API_KEY: SECRET,
        UNKNOWN_KEY: "x",
      }),
    );
    const c = controller({ STEELE_RESEARCH_REQUEST_LIMIT: "5" });
    await c.load();
    expect(c.runtime("model-worker").get("STEELE_RESEARCH_REQUEST_LIMIT")).toBe(5);
    const shown = JSON.stringify(await c.savedState());
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain("UNKNOWN_KEY");
  });

  it("never lets a reader mutate the loaded snapshot", async () => {
    const c = new ConfigurationController({
      env: { STEELE_ARTICLE_SOURCES: "substack/a" },
      salt: "s",
      roles: { bridge: ["STEELE_ARTICLE_SOURCES"] },
    });
    await c.load();
    c.runtime("bridge").get<string[]>("STEELE_ARTICLE_SOURCES")!.push("substack/injected");
    expect(c.runtime("bridge").get("STEELE_ARTICLE_SOURCES")).toEqual(["substack/a"]);
  });

  it("refuses runtime access before a snapshot is loaded", () => {
    expect(() => controller().runtime("model-worker")).toThrow(ConfigurationError);
  });
});
