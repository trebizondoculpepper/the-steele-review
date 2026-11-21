import { describe, expect, it } from "vite-plus/test";
import {
  configurationVersion,
  inspectSettings,
  resolveSettings,
  SETTINGS,
} from "../../src/config/settings.js";

// Sentinels: none of these may ever appear in an inspection projection.
const SECRET = "sk-or-SENTINEL-secret-value";
const HOST = "https://internal-sentinel.example.invalid:8443/v1";
const ORIGIN = "http://10.99.0.7:8090";

const value = (resolved: ReturnType<typeof resolveSettings>, key: string) =>
  resolved.find((r) => r.key === key);

describe("settings registry (#542)", () => {
  it("applies environment, then file, then default precedence", () => {
    const r = resolveSettings(
      { STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT: "3", STEELE_RESEARCH_REQUEST_LIMIT: "" },
      { STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT: "9", STEELE_RESEARCH_REQUEST_LIMIT: "4" },
    );
    expect(value(r, "STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT")).toMatchObject({
      source: "environment",
      value: 3,
    });
    // An empty environment value does not override the file.
    expect(value(r, "STEELE_RESEARCH_REQUEST_LIMIT")).toMatchObject({ source: "file", value: 4 });
    expect(value(r, "STEELE_RESEARCH_MODEL")).toMatchObject({
      source: "default",
      value: "perplexity/sonar-deep-research",
    });
    expect(value(r, "OPENROUTER_API_KEY")).toMatchObject({ source: "missing" });
    expect(value(r, "STEELE_ARTICLE_SOURCES")).toMatchObject({ value: [] });
  });

  it("keeps today's defaults so adoption changes no behaviour", () => {
    const r = resolveSettings({});
    expect(value(r, "STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT")?.value).toBe(5);
    expect(value(r, "STEELE_DASHBOARD_RESEARCH_DEADLINE_MS")?.value).toBe(1_800_000);
    expect(value(r, "STEELE_WRITER_TURN_LIMIT")?.value).toBe(3);
    expect(value(r, "STEELE_WRITER_DEADLINE_MS")?.value).toBe(300000);
    expect(value(r, "STEELE_MODEL_WRITER")?.value).toBe("anthropic/claude-opus-5.5");
    expect(value(r, "OPENROUTER_BASE_URL")).toMatchObject({ source: "default" });
  });

  it("reports invalid values by category, never echoing them", () => {
    const r = resolveSettings({
      STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT: "500",
      OPENROUTER_BASE_URL: "not a url",
    });
    expect(value(r, "STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT")).toEqual({
      key: "STEELE_DASHBOARD_RESEARCH_REQUEST_LIMIT",
      source: "environment",
      error: "invalid",
    });
    const shown = JSON.stringify(inspectSettings(r));
    expect(shown).not.toContain("500");
    expect(shown).not.toContain("not a url");
  });

  it("validates provider endpoints and the console origin as their consumers do", () => {
    const bad = resolveSettings({
      OPENROUTER_BASE_URL: "http://provider.example/api",
      STEELE_DASHBOARD_ORIGIN: "http://console.example/path",
    });
    expect(value(bad, "OPENROUTER_BASE_URL")?.error).toBe("invalid");
    expect(value(bad, "STEELE_DASHBOARD_ORIGIN")?.error).toBe("invalid");
    expect(
      value(
        resolveSettings({ OPENROUTER_BASE_URL: "https://u:p@provider.example/api" }),
        "OPENROUTER_BASE_URL",
      )?.error,
    ).toBe("invalid");
    const good = resolveSettings({
      OPENROUTER_BASE_URL: "https://provider.example/api/v1",
      STEELE_DASHBOARD_ORIGIN: "http://console.example:8090",
    });
    expect(value(good, "OPENROUTER_BASE_URL")?.error).toBeUndefined();
    expect(value(good, "STEELE_DASHBOARD_ORIGIN")?.error).toBeUndefined();
  });

  it("shows only allowlisted public values; private and secret are presence-only", () => {
    const resolved = resolveSettings({
      OPENROUTER_API_KEY: SECRET,
      OPENROUTER_BASE_URL: HOST,
      STEELE_DASHBOARD_ORIGIN: ORIGIN,
      STEELE_ARTICLE_SOURCES: "substack/example",
      UNRELATED_PRIVATE_THING: "also-sentinel",
    });
    const inspected = inspectSettings(resolved);
    const shown = JSON.stringify(inspected);
    for (const sentinel of [
      SECRET,
      HOST,
      ORIGIN,
      "internal-sentinel",
      "10.99.0.7",
      "also-sentinel",
    ]) {
      expect(shown).not.toContain(sentinel);
    }
    expect(shown).not.toContain("UNRELATED_PRIVATE_THING");
    expect(inspected.find((s) => s.key === "OPENROUTER_API_KEY")).toMatchObject({
      sensitivity: "secret",
      state: "configured",
    });
    expect(inspected.find((s) => s.key === "OPENROUTER_API_KEY")).not.toHaveProperty("value");
    expect(inspected.find((s) => s.key === "STEELE_ARTICLE_SOURCES")).toMatchObject({
      value: ["substack/example"],
    });
    // Every registered setting is described once.
    expect(inspected.map((s) => s.key)).toEqual(SETTINGS.map((s) => s.key));
  });

  it("derives a deterministic version that changes with private values but never reveals them", () => {
    const a = resolveSettings({ OPENROUTER_API_KEY: SECRET, STEELE_RESEARCH_REQUEST_LIMIT: "2" });
    const same = resolveSettings({
      STEELE_RESEARCH_REQUEST_LIMIT: "2",
      OPENROUTER_API_KEY: SECRET,
    });
    const rotated = resolveSettings({
      OPENROUTER_API_KEY: `${SECRET}-2`,
      STEELE_RESEARCH_REQUEST_LIMIT: "2",
    });
    const v = configurationVersion(a, "salt");
    expect(v).toMatch(/^config-sha256:[0-9a-f]{32}$/);
    expect(configurationVersion(same, "salt")).toBe(v);
    expect(configurationVersion(rotated, "salt")).not.toBe(v);
    expect(v).not.toContain(SECRET);
  });
});
