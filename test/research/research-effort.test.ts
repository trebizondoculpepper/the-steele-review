import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  OpenRouterSonarClient,
  RESEARCH_EFFORT_SUPPORT,
  ResearchEffortUnsupportedError,
  researchEffortFromEnv,
  sonarFromEnv,
} from "../../src/research/sonar.js";

const support = RESEARCH_EFFORT_SUPPORT as Record<string, readonly string[]>;
afterEach(() => {
  delete support["fixture/effort-model"];
});

/** Captures request bodies; never reaches a provider. */
function capturing() {
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        model: "fixture",
        choices: [{ message: { content: "# Report" }, finish_reason: "stop" }],
        citations: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { bodies, fetch: fetch as typeof globalThis.fetch };
}
const base = { apiKey: "SYNTHETIC", timeoutMs: 10_000, maxOutputTokens: 4000 };

describe("research reasoning effort (#662)", () => {
  it("refuses an effort the current deep-research route cannot select, before any request", () => {
    const t = capturing();
    expect(
      () =>
        new OpenRouterSonarClient({
          ...base,
          model: "perplexity/sonar-deep-research",
          reasoningEffort: "low",
          fetch: t.fetch,
        }),
    ).toThrow(ResearchEffortUnsupportedError);
    expect(t.bodies).toHaveLength(0);
  });

  it("sends the documented request shape and records the effort when the route supports it", async () => {
    support["fixture/effort-model"] = ["low", "high"];
    const t = capturing();
    const client = new OpenRouterSonarClient({
      ...base,
      model: "fixture/effort-model",
      reasoningEffort: "low",
      fetch: t.fetch,
    });
    await client
      .research({ system: "s", user: "u" }, new AbortController().signal)
      .catch(() => undefined);
    expect(t.bodies[0]).toMatchObject({ reasoning: { effort: "low" } });
    expect(client.discoveryParameters).toMatchObject({ reasoningEffort: "low" });
    expect(client.reasoning).toEqual({ configured: "low" });
  });

  it("leaves requests and identity unchanged when no effort is configured", async () => {
    const t = capturing();
    const client = new OpenRouterSonarClient({
      ...base,
      model: "perplexity/sonar-deep-research",
      fetch: t.fetch,
    });
    await client
      .research({ system: "s", user: "u" }, new AbortController().signal)
      .catch(() => undefined);
    expect(t.bodies[0]).not.toHaveProperty("reasoning");
    expect(client.discoveryParameters).not.toHaveProperty("reasoningEffort");
    // No undocumented default is claimed.
    expect(client.reasoning).toEqual({ configured: null, providerDefault: "unknown" });
  });

  it("validates the setting strictly and fails at start-up for an unsupported route", () => {
    expect(researchEffortFromEnv({})).toBeUndefined();
    expect(researchEffortFromEnv({ STEELE_RESEARCH_REASONING_EFFORT: "" })).toBeUndefined();
    expect(researchEffortFromEnv({ STEELE_RESEARCH_REASONING_EFFORT: "high" })).toBe("high");
    expect(() => researchEffortFromEnv({ STEELE_RESEARCH_REASONING_EFFORT: "none" })).toThrow(
      /must be one of/,
    );
    expect(() =>
      sonarFromEnv({
        env: {
          OPENROUTER_API_KEY: "SYNTHETIC",
          STEELE_RESEARCH_MODEL: "perplexity/sonar-deep-research",
          STEELE_RESEARCH_REASONING_EFFORT: "low",
        },
      }),
    ).toThrow(ResearchEffortUnsupportedError);
  });
});
