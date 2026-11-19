import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_QUERY_ALLOWANCE,
  HARD_MAX_QUERIES,
  InvalidQueryPlanInputError,
  QueryPlanner,
  normaliseQuery,
} from "../../src/research/query-plan.js";

// Synthetic values only.
const gaps = [
  { gapId: "g1", requirement: "Whether the synthetic council raised fees by 3%." },
  { gapId: "g2", requirement: "How the synthetic figure compares with last year." },
];

const json = (value: unknown) => JSON.stringify(value);

function provider(responses: Array<string | Error>) {
  let calls = 0;
  return {
    modelVersion: "synthetic-model-v1",
    get calls() {
      return calls;
    },
    complete: async () => {
      const next = responses[Math.min(calls, responses.length - 1)];
      calls++;
      if (next instanceof Error) throw next;
      return next as string;
    },
  };
}

const planner = (responses: Array<string | Error>) => {
  const fake = provider(responses);
  return { fake, planner: new QueryPlanner(fake) };
};

describe("QueryPlanner", () => {
  it("plans distinct reformulations for one gap", async () => {
    const { planner: p } = planner([
      json({
        queries: [
          { gapId: "g1", query: "synthetic council fee increase 3 percent" },
          { gapId: "g1", query: "example-pub synthetic fees raised" },
        ],
      }),
    ]);
    const outcome = await p.plan({ topic: "Synthetic fees", gaps: [gaps[0]!] });
    expect(outcome.status).toBe("planned");
    if (outcome.status !== "planned") return;
    expect(outcome.queries).toEqual([
      { gapId: "g1", query: "synthetic council fee increase 3 percent" },
      { gapId: "g1", query: "example-pub synthetic fees raised" },
    ]);
    expect(outcome.modelVersion).toBe("synthetic-model-v1");
    expect(outcome.promptVersion).toBe("research-query-plan-v1");
  });

  it("shares one allowance across several gaps", async () => {
    const { planner: p } = planner([
      json({
        queries: [
          { gapId: "g1", query: "synthetic fee rise" },
          { gapId: "g2", query: "synthetic fee comparison last year" },
          { gapId: "g1", query: "synthetic council budget vote" },
          { gapId: "g2", query: "synthetic inflation comparison" },
        ],
      }),
    ]);
    const outcome = await p.plan({ topic: "Synthetic fees", gaps, allowance: 3 });
    expect(outcome.status).toBe("planned");
    if (outcome.status !== "planned") return;
    expect(outcome.queries.map((q) => q.gapId)).toEqual(["g1", "g2", "g1"]);
    expect(outcome.queries).toHaveLength(3);
    expect(outcome.dropped.overAllowance).toBe(1);
  });

  it("never repeats a prior query, including a different spelling", async () => {
    const { planner: p } = planner([
      json({
        queries: [
          { gapId: "g1", query: "Synthetic   Fees 2026" },
          { gapId: "g1", query: "synthetic council budget vote" },
        ],
      }),
    ]);
    const outcome = await p.plan({
      topic: "Synthetic fees",
      gaps,
      priorQueries: ["synthetic fees 2026"],
    });
    expect(outcome.status).toBe("planned");
    if (outcome.status !== "planned") return;
    expect(outcome.queries).toEqual([{ gapId: "g1", query: "synthetic council budget vote" }]);
    expect(outcome.dropped.prior).toBe(1);
  });

  it("collapses duplicate spellings into one attempt", async () => {
    const { planner: p } = planner([
      json({
        queries: [
          { gapId: "g1", query: "synthetic fee rise" },
          { gapId: "g1", query: "SYNTHETIC  fee rise" },
        ],
      }),
    ]);
    const outcome = await p.plan({ topic: "Synthetic fees", gaps });
    expect(outcome.status).toBe("planned");
    if (outcome.status !== "planned") return;
    expect(outcome.queries).toHaveLength(1);
    expect(outcome.dropped.duplicate).toBe(1);
  });

  it("refuses a query for a gap that was never supplied", async () => {
    const { planner: p } = planner([
      json({ queries: [{ gapId: "invented-gap", query: "a synthetic query" }] }),
    ]);
    expect(await p.plan({ topic: "Synthetic fees", gaps })).toEqual({
      status: "failed",
      reason: "malformed-output",
      retryable: true,
    });
  });

  it("reports malformed model output after bounded attempts", async () => {
    const { fake, planner: p } = planner(["{not json"]);
    const outcome = await p.plan({ topic: "Synthetic fees", gaps });
    expect(outcome).toEqual({ status: "failed", reason: "malformed-output", retryable: true });
    expect(fake.calls).toBe(2);
  });

  it("treats provider failure as operational, not as absent evidence", async () => {
    const { planner: p } = planner([new Error("credit exhausted")]);
    expect(await p.plan({ topic: "Synthetic fees", gaps })).toEqual({
      status: "failed",
      reason: "provider-failed",
      retryable: true,
    });
  });

  it("accepts JSON in a fenced code block", async () => {
    const { planner: p } = planner([
      "```json\n" + json({ queries: [{ gapId: "g1", query: "synthetic fee rise" }] }) + "\n```",
    ]);
    expect((await p.plan({ topic: "Synthetic fees", gaps })).status).toBe("planned");
  });

  it("plans nothing when evidence is already sufficient or the allowance is spent", async () => {
    const untouched = provider([new Error("must not be called")]);
    const p = new QueryPlanner(untouched);
    expect(await p.plan({ topic: "Synthetic fees", gaps, sufficientEvidence: true })).toEqual({
      status: "empty",
      reason: "sufficient-evidence",
    });
    expect(await p.plan({ topic: "Synthetic fees", gaps, allowance: 0 })).toEqual({
      status: "empty",
      reason: "no-allowance",
    });
    expect(await p.plan({ topic: "Synthetic fees", gaps: [] })).toEqual({
      status: "empty",
      reason: "no-gaps",
    });
    expect(untouched.calls).toBe(0);
  });

  it("reports an empty plan when every proposed query is a repeat", async () => {
    const { planner: p } = planner([
      json({ queries: [{ gapId: "g1", query: "synthetic fee rise" }] }),
    ]);
    expect(
      await p.plan({ topic: "Synthetic fees", gaps, priorQueries: ["synthetic fee rise"] }),
    ).toEqual({ status: "empty", reason: "no-new-queries" });
  });

  it("defaults to the documented allowance", async () => {
    const { planner: p } = planner([
      json({
        queries: Array.from({ length: DEFAULT_QUERY_ALLOWANCE + 2 }, (_, index) => ({
          gapId: "g1",
          query: `synthetic query ${index}`,
        })),
      }),
    ]);
    const outcome = await p.plan({ topic: "Synthetic fees", gaps });
    expect(outcome.status).toBe("planned");
    if (outcome.status !== "planned") return;
    expect(outcome.queries).toHaveLength(DEFAULT_QUERY_ALLOWANCE);
  });

  it.each([
    ["an empty topic", { topic: "  ", gaps }],
    ["a duplicate gap", { topic: "Synthetic fees", gaps: [gaps[0]!, gaps[0]!] }],
    [
      "a malformed gap ID",
      { topic: "Synthetic fees", gaps: [{ gapId: "not an id", requirement: "x" }] },
    ],
    ["a negative allowance", { topic: "Synthetic fees", gaps, allowance: -1 }],
    [
      "an allowance above the hard maximum",
      { topic: "Synthetic fees", gaps, allowance: HARD_MAX_QUERIES + 1 },
    ],
    ["a fractional allowance", { topic: "Synthetic fees", gaps, allowance: 1.5 }],
  ])("rejects %s", async (_name, input) => {
    const { planner: p } = planner([json({ queries: [] })]);
    await expect(p.plan(input as never)).rejects.toBeInstanceOf(InvalidQueryPlanInputError);
  });
});

describe("normaliseQuery", () => {
  it("ignores case, surrounding space and repeated whitespace", () => {
    expect(normaliseQuery("  Synthetic   Fees ")).toBe(normaliseQuery("synthetic fees"));
    expect(normaliseQuery("Synthetic Fees")).not.toBe(normaliseQuery("synthetic fee"));
  });
});
