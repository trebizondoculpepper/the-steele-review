import { describe, expect, it } from "vite-plus/test";
import {
  createClaim,
  InvalidClaimError,
  sourceStatedPeriod,
} from "../../src/analysis/claim.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import {
  PERIOD_NOT_STATED,
  reportingPeriodExclusion,
  reportingPeriodIdentity,
} from "../../src/research/reporting-period.js";

const text = "Results for Q3 2026: Acme reported revenue of $10 million.";
const source = {
  text,
  sourceVersion: sourceVersionFor(text),
  artifact: {
    repository: "synthetic",
    commit: "a".repeat(40),
    path: "acme.md",
    hash: `sha256:${"b".repeat(64)}`,
  },
};
const passage = "Acme reported revenue of $10 million.";
const draft = (reportingPeriod?: {
  dependsOnPeriod: boolean;
  text?: string;
}) => ({
  statement: passage,
  claimType: "factual" as const,
  sourceVersion: source.sourceVersion,
  span: {
    start: text.indexOf(passage),
    end: text.indexOf(passage) + passage.length,
  },
  passage,
  ...(reportingPeriod ? { reportingPeriod } : {}),
  extraction: {
    modelVersion: "m",
    promptVersion: "p",
    extractedAt: "2026-11-25T00:00:00Z",
  },
});

describe("reporting periods (#889)", () => {
  it("accepts a period only in the source's own wording, never an inferred one", () => {
    expect(
      createClaim(draft({ dependsOnPeriod: true, text: "Q3 2026" }), source)
        .reportingPeriod,
    ).toEqual({ dependsOnPeriod: true, text: "Q3 2026" });
    expect(() =>
      createClaim(draft({ dependsOnPeriod: true, text: "Q4 2026" }), source),
    ).toThrow(InvalidClaimError);
    expect(() =>
      createClaim(draft({ dependsOnPeriod: false, text: "Q3 2026" }), source),
    ).toThrow(InvalidClaimError);
  });

  it("excludes a period-dependent claim whose source states no period, with the reason", () => {
    const missing = createClaim(draft({ dependsOnPeriod: true }), source);
    expect(reportingPeriodExclusion(missing)).toBe(PERIOD_NOT_STATED);
    expect(
      reportingPeriodExclusion(
        createClaim(draft({ dependsOnPeriod: true, text: "Q3 2026" }), source),
      ),
    ).toBeUndefined();
    expect(
      reportingPeriodExclusion(
        createClaim(draft({ dependsOnPeriod: false }), source),
      ),
    ).toBeUndefined();
  });

  it("puts a stated period in the identity and keeps older figure claims occurrence-only", () => {
    expect(
      reportingPeriodIdentity(
        createClaim(draft({ dependsOnPeriod: true, text: "Q3 2026" }), source),
      ),
    ).toEqual({ period: "Q3 2026" });
    // Older claims (no field) stay readable and are not excluded.
    const older = createClaim(draft(), source);
    expect(reportingPeriodExclusion(older)).toBeUndefined();
    expect(reportingPeriodIdentity(older)).toBe("occurrence-only");
    expect(
      reportingPeriodIdentity({
        statement: "5G masts were installed overnight.",
      }),
    ).toBeUndefined();
    expect(
      reportingPeriodIdentity({
        statement: "The treaty was signed by 48 states.",
        dates: [{ text: "10 December 1976", value: "1976-12-10" }],
      }),
    ).toBeUndefined();
  });

  it("keeps relative periods occurrence-only and treats currency amounts as figures (#903 review)", () => {
    const withPeriod = (text: string) => ({
      statement: "Acme reported revenue of $10 million.",
      reportingPeriod: { dependsOnPeriod: true, text },
    });
    expect(reportingPeriodIdentity(withPeriod("last year"))).toBe(
      "occurrence-only",
    );
    expect(reportingPeriodIdentity(withPeriod("this quarter"))).toBe(
      "occurrence-only",
    );
    expect(reportingPeriodIdentity(withPeriod("Q3"))).toBe("occurrence-only");
    expect(reportingPeriodIdentity(withPeriod("Q3 2026"))).toEqual({
      period: "Q3 2026",
    });
    expect(
      reportingPeriodIdentity({ statement: "Acme reported revenue of $2026." }),
    ).toBe("occurrence-only");
    expect(
      reportingPeriodIdentity({ statement: "The council met in 2019." }),
    ).toBeUndefined();
  });

  it("drops period wording the source does not contain, so nothing is inferred", () => {
    expect(
      sourceStatedPeriod({ dependsOnPeriod: true, text: "Q4 2026" }, text),
    ).toEqual({
      dependsOnPeriod: true,
    });
    expect(
      sourceStatedPeriod({ dependsOnPeriod: true, text: "Q3 2026" }, text),
    ).toEqual({
      dependsOnPeriod: true,
      text: "Q3 2026",
    });
    expect(
      sourceStatedPeriod({ dependsOnPeriod: false, text: "Q3 2026" }, text),
    ).toEqual({
      dependsOnPeriod: false,
    });
  });
});
