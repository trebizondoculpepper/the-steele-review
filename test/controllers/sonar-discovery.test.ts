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

it("serializes canonical semantic scope without changing legacy subject request bytes", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "SYNTHETIC-REQUEST-KEY");
  vi.stubEnv("OPENROUTER_API_KEY_FILE", "");
  const sent: { messages: { content: string }[] }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          model: "fixture/research",
          choices: [{ finish_reason: "stop", message: { content: "# Synthetic report" } }],
          citations: [],
        }),
      );
    }),
  );
  const { CanonicalNeedSchema, canonicalNeedId } =
    await import("../../src/research/canonical-need.js");
  const { ResearchRequestSchema } = await import("../../src/research/job.js");
  const need = CanonicalNeedSchema.parse({
    version: "canonical-theme-need-v1",
    themeId: "enmod",
    proposition: {
      statement: "The ENMOD Convention was adopted in 1976.",
      kind: "quotation",
      claimType: "factual",
      qualifiers: ["allegedly"],
      entities: ["ENMOD Convention"],
      dates: [{ text: "1976" }],
      attribution: { name: "Synthetic Witness" },
    },
  });
  const canonical = ResearchRequestSchema.parse({
    schemaVersion: 1,
    origin: "theme",
    pass: 1,
    claims: [
      {
        claimRecordId: canonicalNeedId(need),
        statement: need.proposition.statement,
        themeIds: ["enmod"],
      },
    ],
    question: "Check the scoped assertion.",
    corpusRefs: [],
    canonicalNeeds: { version: "canonical-theme-needs-v1", needs: [need] },
  });
  const provider = sonarFromEnv({ model: "fixture/research", timeoutMs: 1000, maxTokens: 4000 });
  await provider(canonical);
  expect(JSON.parse(sent[0]!.messages[1]!.content).canonicalNeeds).toEqual(
    canonical.canonicalNeeds,
  );
  await provider(request);
  expect(sent[1]!.messages[1]!.content).toBe(
    JSON.stringify({
      subject: request.subject,
      brief: undefined,
      question: undefined,
      claims: request.claims,
    }),
  );
});
