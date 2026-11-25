import { describe, expect, it } from "vite-plus/test";
import { groupingReport } from "../../src/corpus-refinement/contracts.js";

// Group sizes and the near one-to-one flag (#849): synthetic ideas only.
const ideas = (...sizes: number[]) => {
  let next = 0;
  return sizes.map((n) => ({ claimIds: Array.from({ length: n }, () => `c${next++}`) }));
};

describe("claim grouping report (#849)", () => {
  it("reports group sizes and flags a near one-to-one result for review", () => {
    expect(groupingReport(ideas(1, 1, 1, 1, 1, 1, 1, 1, 1, 1))).toEqual({
      claims: 10,
      ideas: 10,
      sizes: { "1": 10 },
      review: "near-one-to-one",
    });
  });

  it("does not flag a batch with real groups, and keeps singletons", () => {
    expect(groupingReport(ideas(3, 2, 1, 1, 1))).toEqual({
      claims: 8,
      ideas: 5,
      sizes: { "1": 3, "2": 1, "3": 1 },
    });
  });

  it("does not flag a batch too small to judge, or an empty one", () => {
    expect(groupingReport(ideas(1, 1, 1)).review).toBeUndefined();
    expect(groupingReport([])).toEqual({ claims: 0, ideas: 0, sizes: {} });
  });

  it("counts a claim repeated within one idea once", () => {
    expect(groupingReport([{ claimIds: ["c1", "c1", "c2"] }]).sizes).toEqual({ "2": 1 });
  });
});
