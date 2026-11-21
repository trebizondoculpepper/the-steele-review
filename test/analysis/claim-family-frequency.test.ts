import { describe, expect, it } from "vite-plus/test";
import {
  assessClaimFamilyFrequency,
  renderFrequencyReport,
  type FrequencyInput,
} from "../../src/analysis/claim-family-frequency.js";

// Synthetic fixtures only: fixed rates and expanding coverage.
const base: FrequencyInput = {
  scope: "collected posts from one synthetic publication",
  window: { from: "2025-01-01", to: "2026-06-30" },
  periods: [
    { period: "2025-H1", matchedPosts: 5, distinctOccurrences: 6, analysedPosts: 50 },
    { period: "2025-H2", matchedPosts: 10, distinctOccurrences: 12, analysedPosts: 100 },
  ],
  coverage: "known",
  minimumAnalysedPosts: 20,
  minimumRateDelta: 0.05,
};

describe("claim family frequency (#404)", () => {
  it("does not assert an increase when counts grow only because coverage grew", () => {
    // Rate is 10% in both periods; only the denominator doubled.
    const a = assessClaimFamilyFrequency(base);
    expect(a.kind).toBe("observed");
    if (a.kind !== "observed") throw new Error(a.kind);
    expect(a.direction).toBe("flat");
    expect(a.statement).toMatch(/No change in observed rate/);
    expect(a.statement).toMatch(/Raw counts may differ because more posts were analysed/);
    // Raw distinct occurrences are preserved and reported separately.
    expect(a.observations.map((o) => o.distinctOccurrences)).toEqual([6, 12]);
  });

  it("keeps identical rates flat even when the caller sets a zero threshold", () => {
    const a = assessClaimFamilyFrequency({
      ...base,
      minimumRateDelta: 0,
      periods: [
        { period: "2025-H1", matchedPosts: 5, distinctOccurrences: 5, analysedPosts: 50 },
        { period: "2025-H2", matchedPosts: 5, distinctOccurrences: 5, analysedPosts: 50 },
      ],
    });
    expect(a.kind).toBe("observed");
    if (a.kind !== "observed") throw new Error(a.kind);
    expect(a.direction).toBe("flat");
  });

  it("compares exact fractions, so rounding cannot create a trend", () => {
    // 1/10001 and 501/10001 differ by exactly the threshold; rounded rates would drift.
    const a = assessClaimFamilyFrequency({
      ...base,
      minimumRateDelta: 0.05,
      minimumAnalysedPosts: 1,
      periods: [
        { period: "p1", matchedPosts: 1, distinctOccurrences: 1, analysedPosts: 10_001 },
        { period: "p2", matchedPosts: 501, distinctOccurrences: 501, analysedPosts: 10_001 },
      ],
    });
    expect(a.kind).toBe("observed");
    if (a.kind !== "observed") throw new Error(a.kind);
    // 500/10001 is just under 0.05, so this is flat rather than an increase.
    expect(a.direction).toBe("flat");
  });

  it("reports a fully specified observed-rate increase with its scope", () => {
    const a = assessClaimFamilyFrequency({
      ...base,
      periods: [
        { period: "2025-H1", matchedPosts: 5, distinctOccurrences: 5, analysedPosts: 100 },
        { period: "2025-H2", matchedPosts: 20, distinctOccurrences: 24, analysedPosts: 100 },
      ],
    });
    expect(a.kind).toBe("observed");
    if (a.kind !== "observed") throw new Error(a.kind);
    expect(a.direction).toBe("increase");
    expect(a.statement).toMatch(/Observed rate increase/);
    expect(a.statement).toContain(base.scope);
    expect(a.thresholds).toEqual({ minimumAnalysedPosts: 20, minimumRateDelta: 0.05 });
    expect(a.limitations[0]).toMatch(/not prevalence/);
  });

  it("treats a change exactly at the threshold as a change, in both directions", () => {
    // 10/100 -> 15/100 is exactly 0.05, but 0.15 - 0.10 is 0.04999... in floating point.
    const at = (from: number, to: number) => {
      const a = assessClaimFamilyFrequency({
        ...base,
        periods: [
          { period: "2025-H1", matchedPosts: from, distinctOccurrences: from, analysedPosts: 100 },
          { period: "2025-H2", matchedPosts: to, distinctOccurrences: to, analysedPosts: 100 },
        ],
      });
      return a.kind === "observed" ? a.direction : a.kind;
    };
    expect(at(10, 15)).toBe("increase");
    expect(at(15, 10)).toBe("decrease");
    expect(at(10, 14)).toBe("flat");
  });

  it("returns a qualified no-assessment for unknown coverage", () => {
    const a = assessClaimFamilyFrequency({ ...base, coverage: "unknown" });
    expect(a.kind).toBe("no-assessment");
    if (a.kind !== "no-assessment") throw new Error(a.kind);
    expect(a.reasons).toContain("extraction coverage over the window is unknown");
    expect(renderFrequencyReport(a)).toMatch(/No assessment/);
  });

  it("returns no-assessment for a truncated or sparsely dated result", () => {
    for (const patch of [{ truncated: true }, { datesSparse: true }]) {
      const a = assessClaimFamilyFrequency({ ...base, ...patch });
      expect(a.kind).toBe("no-assessment");
    }
  });

  it("returns no-assessment when a period is below the declared denominator", () => {
    const a = assessClaimFamilyFrequency({
      ...base,
      periods: [
        { period: "2025-H1", matchedPosts: 1, distinctOccurrences: 1, analysedPosts: 5 },
        { period: "2025-H2", matchedPosts: 10, distinctOccurrences: 10, analysedPosts: 100 },
      ],
    });
    expect(a.kind).toBe("no-assessment");
    if (a.kind !== "no-assessment") throw new Error(a.kind);
    expect(a.reasons.join(" ")).toMatch(/analysed fewer than 20 posts/);
  });

  it("keeps the same counts and limitations on rerun", () => {
    const first = renderFrequencyReport(assessClaimFamilyFrequency(base));
    const second = renderFrequencyReport(assessClaimFamilyFrequency(base));
    expect(second).toBe(first);
    expect(first).toMatch(/period\tmatchedPosts\tanalysedPosts\trate\tdistinctOccurrences/);
  });
});
