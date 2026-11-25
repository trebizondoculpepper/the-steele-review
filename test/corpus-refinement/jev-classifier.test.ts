import { describe, expect, it } from "vite-plus/test";
import {
  JevClassifier,
  NO_MATCH,
  jevRequest,
  shortlist,
  type JevCall,
} from "../../src/corpus-refinement/jev-classifier.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";

const catalogue = {
  version: "v1",
  entries: [
    {
      id: "masts-cause-illness",
      definition: "Radio masts are said to make people ill.",
      examples: [{ text: "5G masts cause headaches.", source: "claim:1" }],
    },
    {
      id: "weather-is-engineered",
      definition: "Weather events are said to be deliberately engineered.",
      examples: [
        {
          text: "The floods were created by cloud seeding.",
          source: "claim:2",
        },
      ],
    },
  ],
};
const record = {
  id: "r1",
  statement: "Phone masts are making the village sick.",
};

const reply =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
const answer = (choice: string, confidence: number, cost = 0.000004) => ({
  id: "x",
  model: "typesafe/jev-1.14",
  answers: { idea: { type: "choice", choice, confidence, probabilities: {} } },
  usage: { input_tokens: 120, output_tokens: 0, cost },
});

describe("Jev classifier (#860)", () => {
  it("asks one choice question over the shortlist with an explicit no-match option", () => {
    const req = jevRequest(record, catalogue.entries, "typesafe/jev-1.14");
    expect(req.model).toBe("typesafe/jev-1.14");
    expect(Object.keys(req.questions.idea.criteria)).toEqual([
      "masts-cause-illness",
      "weather-is-engineered",
      NO_MATCH,
    ]);
    expect(JSON.stringify(req)).toContain("5G masts cause headaches.");
  });

  it("bounds the shortlist to the entries closest to the claim", () => {
    expect(shortlist(record, catalogue, 1).map((e) => e.id)).toEqual([
      "masts-cause-illness",
    ]);
    expect(shortlist(record, catalogue, 5)).toHaveLength(2);
  });

  it("maps a confident answer, banding confidence by the calibrated thresholds, and reports the call", async () => {
    const calls: JevCall[] = [];
    let sent: RequestInit | undefined;
    const jev = new JevClassifier({
      apiKey: "test-key",
      thresholds: { high: 0.9, medium: 0.7 },
      fetch: (async (_url: string, init: RequestInit) => {
        sent = init;
        return reply(answer("masts-cause-illness", 0.8))();
      }) as never,
      onCall: (c) => calls.push(c),
    });
    expect(await jev.classifyOne(record, catalogue)).toMatchObject({
      decision: "mapped",
      catalogueId: "masts-cause-illness",
      confidence: "medium",
    });
    expect((sent!.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
    expect(calls).toEqual([
      {
        recordId: "r1",
        latencyMs: expect.any(Number),
        inputTokens: 120,
        cost: 0.000004,
      },
    ]);
    expect(jev.version).toContain("typesafe/jev-1.14");
    // The prompt files' content hashes are part of the recorded identity.
    expect(jev.version).toMatch(/mapping-jev-choice-sha256:[0-9a-f]{64}/);
    expect(jev.version).toMatch(/mapping-jev-no-match-sha256:[0-9a-f]{64}/);
  });

  it("routes no-match, refusal and answers outside the shortlist to unmapped", async () => {
    const run = (body: unknown) =>
      new JevClassifier({
        apiKey: "k",
        fetch: reply(body) as never,
      }).classifyOne(record, catalogue);
    expect(await run(answer(NO_MATCH, 0.95))).toMatchObject({
      reason: "jev-no-match",
    });
    expect(await run(answer("invented-id", 0.95))).toMatchObject({
      reason: "shortlist-miss",
    });
    expect(
      await run({
        answers: { idea: { type: "refusal" } },
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    ).toMatchObject({ reason: "jev-refusal" });
  });

  it("throws provider failures so they are retried, never unmapped", async () => {
    for (const [status, code] of [
      [402, "credit-exhausted"],
      [429, "rate-limited"],
      [503, "unavailable"],
    ] as const) {
      const jev = new JevClassifier({
        apiKey: "k",
        fetch: reply({ error: {} }, status) as never,
      });
      await expect(jev.classifyOne(record, catalogue)).rejects.toMatchObject({
        code,
      });
    }
    const bad = new JevClassifier({
      apiKey: "k",
      fetch: reply({ nonsense: true }) as never,
    });
    await expect(bad.classifyOne(record, catalogue)).rejects.toBeInstanceOf(
      ModelProviderError,
    );
  });
});
