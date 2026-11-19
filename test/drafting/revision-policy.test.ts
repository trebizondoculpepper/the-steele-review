import { describe, expect, it } from "vite-plus/test";
import {
  InvalidRevisionInputError,
  decideRevision,
  type RevisionInput,
} from "../../src/drafting/revision-policy.js";

const h = (c: string) => `sha256:${c.repeat(64)}`;
const markdown = "Original post: https://pub.substack.com/p/p\n\nUncertainty: medium.\n";
const input = (
  over: Partial<RevisionInput> = {},
  report: Partial<RevisionInput["report"]> = {},
): RevisionInput => ({
  revisionCount: 0,
  draft: { hash: h("d"), markdown },
  brief: { hash: h("b") },
  report: {
    verdict: "approve",
    draft: { path: "drafts/pub/p/d.md", commit: "c".repeat(40), hash: h("d") },
    brief: { path: "briefs/pub/p/b.json", commit: "c".repeat(40), hash: h("b") },
    issues: [],
    ...report,
  },
  ...over,
});
const issue = {
  source: "verifier" as const,
  passage: "Uncertainty: medium.",
  problem: "Too certain.",
  requiredChange: "Say high.",
};

describe("decideRevision", () => {
  it("approves the exact draft on an initial pass", () => {
    expect(decideRevision(input())).toEqual({
      action: "approve",
      draftHash: h("d"),
      briefHash: h("b"),
    });
  });

  it("requests a targeted redraft with feedback anchored to actual passages", () => {
    const d = decideRevision(
      input(
        {},
        {
          verdict: "redraft",
          issues: [
            issue,
            { ...issue, passage: "Not in this draft." },
            { ...issue, passage: undefined },
          ],
        },
      ),
    );
    expect(d).toEqual({ action: "redraft", revision: 1, feedback: [issue] });
  });

  it("skips when revisions are exhausted, by default after two", () => {
    expect(
      decideRevision(input({ revisionCount: 1 }, { verdict: "redraft", issues: [issue] })),
    ).toMatchObject({ action: "redraft", revision: 2 });
    expect(
      decideRevision(input({ revisionCount: 2 }, { verdict: "redraft", issues: [issue] })),
    ).toEqual({ action: "skip", reason: "revisions-exhausted" });
    expect(
      decideRevision(input({ revisionCount: 0 }, { verdict: "redraft", issues: [issue] }), {
        maxRevisions: 0,
      }),
    ).toEqual({
      action: "skip",
      reason: "revisions-exhausted",
    });
  });

  it("skips unrepairable evidence gaps, verifier skips and unanchored feedback", () => {
    expect(
      decideRevision(
        input({ evidenceGapUnrepairable: true }, { verdict: "redraft", issues: [issue] }),
      ),
    ).toEqual({
      action: "skip",
      reason: "unrepairable-evidence-gap",
    });
    expect(decideRevision(input({}, { verdict: "skip", issues: [issue] }))).toEqual({
      action: "skip",
      reason: "verifier-skipped",
    });
    expect(
      decideRevision(
        input({}, { verdict: "redraft", issues: [{ ...issue, passage: "elsewhere" }] }),
      ),
    ).toEqual({
      action: "skip",
      reason: "no-actionable-feedback",
    });
  });

  it("never lets a changed draft or brief inherit an earlier approval", () => {
    expect(() => decideRevision(input({ draft: { hash: h("e"), markdown } }))).toThrow(
      InvalidRevisionInputError,
    );
    expect(() => decideRevision(input({ brief: { hash: h("f") } }))).toThrow("stale-report");
  });

  it("does not approve when an approving report still lists issues", () => {
    expect(decideRevision(input({}, { verdict: "approve", issues: [issue] }))).toEqual({
      action: "redraft",
      revision: 1,
      feedback: [issue],
    });
  });

  it("rejects invalid counts and configuration", () => {
    expect(() => decideRevision(input({ revisionCount: -1 }))).toThrow("invalid-count");
    expect(() => decideRevision(input({ revisionCount: 1.5 }))).toThrow("invalid-count");
    expect(() => decideRevision(input({ revisionCount: 3 }))).toThrow("invalid-count");
    expect(() => decideRevision(input(), { maxRevisions: -1 })).toThrow("invalid-config");
    expect(() => decideRevision(input(), { maxRevisions: 99 })).toThrow("invalid-config");
  });
});
