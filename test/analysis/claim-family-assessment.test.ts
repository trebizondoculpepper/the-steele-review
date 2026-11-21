import { describe, expect, it } from "vite-plus/test";
import type { ArtifactRef } from "../../src/content/artifact-reference.js";
import {
  assessPinnedCorpusPeriods,
  renderPinnedFrequencyReport,
} from "../../src/analysis/claim-family-assessment.js";

// Synthetic fixtures only.
const ref: ArtifactRef = {
  repository: "synthetic-content",
  commit: "a".repeat(40),
  path: "corpus-periods/synthetic.json",
  hash: "b".repeat(64),
};

const period = (over: Record<string, unknown> = {}) => ({
  month: "2025-01",
  archivedPosts: 100,
  analysedPosts: 100,
  matchedPosts: 10,
  occurrences: 12,
  quotedOccurrences: 0,
  identicalSourceCopies: 0,
  excludedCopies: 0,
  missingExtractions: 0,
  invalidExtractions: 0,
  candidateClaims: 0,
  rejectedClaims: 0,
  ...over,
});

const result = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  projectorVersion: "corpus-periods-v1",
  manifest: {
    repository: "synthetic-content",
    commit: "c".repeat(40),
    path: "corpus-periods/manifest.json",
    sha256: "d".repeat(64),
  },
  family: { name: "synthetic family", groupingKeys: [`sha256:${"e".repeat(64)}`] },
  scope: { description: "collected posts from one synthetic publication", publications: ["pub"], complete: true },
  window: { start: "2025-01", end: "2025-02" },
  exactCopies: "include",
  periods: [period(), period({ month: "2025-02" })],
  diagnostics: {
    duplicateEntries: 0,
    unavailableSources: 0,
    invalidSources: 0,
    unknownDates: 0,
    outsideWindow: 0,
    incompleteCaptures: 0,
  },
  truncated: false,
  caveats: [],
  ...over,
});

const reader = (body: unknown) => ({
  read: async () => JSON.stringify(body),
});

describe("pinned corpus period assessment (#404)", () => {
  it("retains the exact input reference and keeps a flat rate flat", async () => {
    const a = await assessPinnedCorpusPeriods({ artifacts: reader(result()), result: ref });
    expect(a.input).toEqual(ref);
    expect(a.assessment.kind).toBe("observed");
    if (a.assessment.kind !== "observed") throw new Error(a.assessment.kind);
    expect(a.assessment.direction).toBe("flat");
    const report = renderPinnedFrequencyReport(a);
    expect(report).toContain(`Input: synthetic-content@${ref.commit}:${ref.path} (${ref.hash})`);
    expect(report).toMatch(/Limitations:/);
    expect(report).toMatch(/not prevalence/);
  });

  it("treats unavailable or invalid sources as coverage gaps", async () => {
    const a = await assessPinnedCorpusPeriods({
      artifacts: reader(
        result({
          diagnostics: {
            duplicateEntries: 0,
            unavailableSources: 3,
            invalidSources: 1,
            unknownDates: 0,
            outsideWindow: 0,
            incompleteCaptures: 0,
          },
        }),
      ),
      result: ref,
    });
    expect(a.assessment.kind).toBe("no-assessment");
    expect(a.limitations.join(" ")).toMatch(/4 archived posts have no usable extraction/);
  });

  it("assesses a result spanning more than 60 months", async () => {
    const months = Array.from({ length: 72 }, (_, i) => {
      const year = 2020 + Math.floor(i / 12);
      const month = String((i % 12) + 1).padStart(2, "0");
      return period({ month: `${year}-${month}`, archivedPosts: 30, analysedPosts: 30, matchedPosts: 3, occurrences: 3 });
    });
    const a = await assessPinnedCorpusPeriods({
      artifacts: reader(result({ periods: months, window: { start: months[0]!.month, end: months.at(-1)!.month } })),
      result: ref,
    });
    expect(a.periods).toHaveLength(72);
    expect(a.assessment.kind).toBe("observed");
  });

  it("maps every period, preserving a zero-count month instead of dropping it", async () => {
    const a = await assessPinnedCorpusPeriods({
      artifacts: reader(
        result({
          periods: [
            period({ month: "2025-01", archivedPosts: 5, analysedPosts: 0, matchedPosts: 0, occurrences: 0, missingExtractions: 5 }),
            period({ month: "2025-02" }),
          ],
        }),
      ),
      result: ref,
    });
    expect(a.periods.map((p) => p.month)).toEqual(["2025-01", "2025-02"]);
    expect(a.periods[0]).toMatchObject({ analysedPosts: 0, rate: 0, matchedPosts: 0 });
    expect(a.assessment.kind).toBe("no-assessment");
    if (a.assessment.kind !== "no-assessment") throw new Error(a.assessment.kind);
    expect(a.assessment.reasons.join(" ")).toMatch(/have no analysed posts/);
    expect(a.limitations.join(" ")).toMatch(/no usable extraction/);
  });

  it("derives unknown coverage from the result rather than trusting the caller", async () => {
    const a = await assessPinnedCorpusPeriods({
      artifacts: reader(result({ scope: { description: "partial sample", publications: ["pub"], complete: false } })),
      result: ref,
    });
    expect(a.assessment.kind).toBe("no-assessment");
    expect(a.limitations.join(" ")).toMatch(/not exhaustive/);
  });

  it("records exclusions when identical-source copies were excluded", async () => {
    const a = await assessPinnedCorpusPeriods({
      artifacts: reader(
        result({
          exactCopies: "exclude-identical-source",
          periods: [
            period({ excludedCopies: 4, archivedPosts: 104 }),
            period({ month: "2025-02", excludedCopies: 1, archivedPosts: 101 }),
          ],
        }),
      ),
      result: ref,
    });
    expect(a.exclusions.join(" ")).toMatch(/identical-source copies were excluded/);
    expect(a.exclusions.join(" ")).toMatch(/5 identical-source copies excluded/);
    expect(renderPinnedFrequencyReport(a)).toMatch(/Exclusions:/);
  });

  it("treats unknown dates and truncation as limitations that block a claim", async () => {
    const a = await assessPinnedCorpusPeriods({
      artifacts: reader(
        result({
          truncated: true,
          diagnostics: {
            duplicateEntries: 0,
            unavailableSources: 0,
            invalidSources: 0,
            unknownDates: 7,
            outsideWindow: 0,
            incompleteCaptures: 0,
          },
        }),
      ),
      result: ref,
    });
    expect(a.assessment.kind).toBe("no-assessment");
    expect(a.limitations.join(" ")).toMatch(/7 posts have unknown dates/);
    expect(a.limitations.join(" ")).toMatch(/truncated/);
  });
});
