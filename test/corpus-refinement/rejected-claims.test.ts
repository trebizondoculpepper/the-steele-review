import { describe, expect, it } from "vite-plus/test";
import { collectRejectedClaims } from "../../src/corpus-refinement/rejected-claims.js";

// The reject handler's rules on synthetic saved values (#855).
const ref = (path: string) => ({
  repository: "r",
  commit: "c".repeat(40),
  path,
  sha256: "a".repeat(64),
});
const claims = [
  { id: "c1", statement: "Claim one.", utterance: "they said claim one", post: "pub/p1" },
  { id: "c2", statement: "Claim two.", post: "pub/p2" },
  { id: "c3", statement: "Claim three." },
];
const ideas = {
  ideas: [
    { id: "i1", claimIds: ["c1", "c2"] },
    { id: "i2", claimIds: ["c2"] },
    { id: "i3", claimIds: ["c3"] },
  ],
};

describe("rejected-claims batch (#855)", () => {
  it("attributes unmapped claims and traces ungrouped ideas back to their claims", () => {
    const out = collectRejectedClaims({
      runId: "run-a",
      claims,
      ideas,
      grouped: ["i2", "i3"],
      rejected: [
        {
          output: ref("first"),
          value: { from: "map-claims-to-ideas", sent: 4, unplaced: ["c3", "c9"], issues: [] },
        },
        {
          output: ref("second"),
          value: { from: "map-ideas-to-underlying", sent: 3, unplaced: ["i1"], issues: [] },
        },
      ],
      sources: {
        batch: ref("batch"),
        ideas: ref("ideas"),
        rejected: [ref("first"), ref("second")],
      },
    });
    expect(out.entries).toEqual([
      // c9 is not in the batch: never guessed.
      {
        claimId: "c3",
        statement: "Claim three.",
        stage: "map-claims-to-ideas",
        reason: "unmapped",
      },
      {
        claimId: "c1",
        statement: "Claim one.",
        utterance: "they said claim one",
        post: "pub/p1",
        stage: "map-ideas-to-underlying",
        reason: "idea-not-grouped",
        ideaId: "i1",
      },
      {
        claimId: "c2",
        statement: "Claim two.",
        post: "pub/p2",
        stage: "map-ideas-to-underlying",
        reason: "idea-not-grouped",
        ideaId: "i1",
        // c2 was also carried by i2, which was grouped: that link is kept.
        acceptedElsewhere: ["i2"],
      },
    ]);
    expect(out).toMatchObject({ schemaVersion: 1, kind: "corpus-rejected-claims", runId: "run-a" });
  });

  it("keeps invalid candidates by reference and whole-response failures apart", () => {
    const out = collectRejectedClaims({
      runId: "run-b",
      claims,
      ideas,
      grouped: [],
      rejected: [
        {
          output: ref("first"),
          value: {
            from: "map-claims-to-ideas",
            sent: 3,
            unplaced: [],
            issues: [
              { index: 2, id: "bad", reason: "quote-not-in-claim:c1" },
              { index: -1, reason: "truncated:200" },
            ],
          },
        },
      ],
      sources: { batch: ref("batch"), ideas: ref("ideas"), rejected: [ref("first")] },
    });
    // The malformed candidate is not attributed to c1, even though its reason names it.
    expect(out.entries).toEqual([]);
    expect(out.candidates).toEqual([
      {
        stage: "map-claims-to-ideas",
        index: 2,
        id: "bad",
        reason: "quote-not-in-claim:c1",
        output: ref("first"),
      },
    ]);
    expect(out.technical).toEqual([
      { stage: "map-claims-to-ideas", reason: "truncated:200", output: ref("first") },
    ]);
  });
});
