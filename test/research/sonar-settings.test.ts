import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SONAR_MAX_OUTPUT_TOKENS,
  DEFAULT_SONAR_MODEL,
  DEFAULT_SONAR_TIMEOUT_MS,
  sonarFromEnv,
} from "../../src/research/sonar.js";

// Deployment checks read the effective research settings, never the key (#317).
describe("Sonar effective settings", () => {
  it.each([undefined, "", " ", "\t\n"])(
    "uses the shared optional-model fallback for %j",
    (model) => {
      expect(
        sonarFromEnv({ env: { OPENROUTER_API_KEY: "synthetic-key", STEELE_RESEARCH_MODEL: model } })
          .settings.model,
      ).toBe(DEFAULT_SONAR_MODEL);
    },
  );

  it("rejects invalid nonblank model configuration before any request", () => {
    expect(() =>
      sonarFromEnv({
        env: { OPENROUTER_API_KEY: "synthetic-key", STEELE_RESEARCH_MODEL: "bad model" },
      }),
    ).toThrow();
  });

  it("reports configured values and treats empty values as defaults", () => {
    const configured = sonarFromEnv({
      env: {
        OPENROUTER_API_KEY: "test-key",
        STEELE_RESEARCH_MODEL: "perplexity/sonar-pro",
        STEELE_RESEARCH_TIMEOUT_MS: "900000",
        STEELE_RESEARCH_MAX_TOKENS: "",
      },
    });
    expect(configured.settings).toEqual({
      model: "perplexity/sonar-pro",
      timeoutMs: 900_000,
      maxOutputTokens: DEFAULT_SONAR_MAX_OUTPUT_TOKENS,
    });
    expect(JSON.stringify(configured.settings)).not.toContain("test-key");
    const defaults = sonarFromEnv({
      env: { OPENROUTER_API_KEY: "k", STEELE_RESEARCH_MODEL: "", STEELE_RESEARCH_TIMEOUT_MS: "" },
    });
    expect(defaults.settings).toEqual({
      model: DEFAULT_SONAR_MODEL,
      timeoutMs: DEFAULT_SONAR_TIMEOUT_MS,
      maxOutputTokens: DEFAULT_SONAR_MAX_OUTPUT_TOKENS,
    });
  });
});

it("reads the canonical live token knob for current outbound settings, never the old duplicate name", async () => {
  const env = { OPENROUTER_API_KEY: "synthetic-key", STEELE_RESEARCH_MAX_TOKENS: "12000" };
  const client = sonarFromEnv({ env });
  expect(await client.currentSettings()).toMatchObject({
    maxOutputTokens: 12000,
    source: "environment",
  });
  env.STEELE_RESEARCH_MAX_TOKENS = "16000";
  expect(await client.currentSettings()).toMatchObject({ maxOutputTokens: 16000 });
});
