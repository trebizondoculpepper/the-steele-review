import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { sonarFromEnv } from "../../src/controllers/sonar.js";
const request = {
  schemaVersion: 1 as const,
  origin: "manual" as const,
  pass: 1,
  subject: "Synthetic subject",
  claims: [],
  corpusRefs: [],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("manual Sonar per-call returned-body capture", () => {
  it.each([
    '{"choices":[',
    JSON.stringify({ choices: [{ message: { content: { invalid: "report" } } }] }),
  ])("captures invalid JSON/schema before rejecting it", async (raw) => {
    vi.stubEnv("OPENROUTER_API_KEY", "SYNTHETIC-REQUEST-KEY");
    vi.stubEnv("OPENROUTER_API_KEY_FILE", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(raw)),
    );
    const provider = sonarFromEnv({ model: "fixture/research", timeoutMs: 1000, maxTokens: 4000 }),
      capture = vi.fn(async (_value: unknown) => undefined);
    await expect(provider(request, capture)).rejects.toMatchObject({ code: "invalid-report" });
    const captured = capture.mock.calls[0][0] as { body: string; encoding: string };
    expect(captured.encoding).toBe("base64");
    expect(Buffer.from(captured.body, "base64").toString("utf8")).toBe(raw);
    expect(capture.mock.calls[0]).not.toContain("SYNTHETIC-REQUEST-KEY");
    expect(provider.discoveryProcessor).toMatchObject({
      model: "fixture/research",
      parameters: { timeoutMs: 1000, maxOutputTokens: 4000 },
    });
  });
  it.each([
    [400, "bad-request"],
    [401, "unauthorised"],
    [403, "unauthorised"],
    [429, "rate-limited"],
    [402, "budget-exceeded"],
  ] as const)("preserves definite HTTP rejection %i", async (status, code) => {
    vi.stubEnv("OPENROUTER_API_KEY", "SYNTHETIC-REQUEST-KEY");
    vi.stubEnv("OPENROUTER_API_KEY_FILE", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("untrusted error body", { status })),
    );
    const provider = sonarFromEnv({ model: "fixture/research", timeoutMs: 1000, maxTokens: 4000 }),
      capture = vi.fn(async (_value: unknown) => undefined);
    await expect(provider(request, capture)).rejects.toMatchObject({ code, status });
    expect(capture).not.toHaveBeenCalled();
  });
});
