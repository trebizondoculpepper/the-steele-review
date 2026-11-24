import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { extractRecords, quotedIn } from "../../src/corpus-refinement/model-step.js";

// Stage-supplied rules, as the claims-to-ideas mapping will supply them (#836).
const CLAIMS: Record<string, string> = {
  c1: "The new mast is secretly making people in the town ill.",
  c2: "Masts cause illness, the council admits nothing.",
};
const Idea = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
    claimIds: z.array(z.string()).min(1),
    evidence: z.array(z.object({ claimId: z.string(), quote: z.string() })).min(1),
  })
  .strict();
type Idea = z.infer<typeof Idea>;
const check = (idea: Idea) => {
  const unknown = idea.claimIds.find((id) => !(id in CLAIMS));
  if (unknown) return `unknown-claim:${unknown}`;
  for (const e of idea.evidence) {
    if (!idea.claimIds.includes(e.claimId)) return `evidence-outside-idea:${e.claimId}`;
    if (!quotedIn(e.quote, CLAIMS[e.claimId] ?? "")) return `quote-not-in-source:${e.claimId}`;
  }
  return undefined;
};
const idea = (over: Partial<Idea>): Idea => ({
  id: "idea-masts-illness",
  statement: "Phone masts make people ill.",
  claimIds: ["c1"],
  evidence: [{ claimId: "c1", quote: "secretly making people in the town ill" }],
  ...over,
});

describe("Corpus Refinement extraction and partial validation (#836)", () => {
  it("keeps valid records and reports each invalid one, from one mixed response", () => {
    const response = `Here you go:\n${JSON.stringify({
      ideas: [
        idea({}),
        idea({ id: "idea-bad-quote", evidence: [{ claimId: "c1", quote: "invented words" }] }),
        idea({
          id: "idea-unknown-claim",
          claimIds: ["c9"],
          evidence: [{ claimId: "c9", quote: "x" }],
        }),
        { id: "idea-missing-fields", statement: "No claims" },
        idea({
          id: "idea-whitespace-quote",
          claimIds: ["c2"],
          evidence: [{ claimId: "c2", quote: "Masts  cause\nillness" }],
        }),
      ],
    })}`;
    const out = extractRecords(response, { listKey: "ideas", schema: Idea, check });
    expect(out.accepted.map((i) => i.id)).toEqual(["idea-masts-illness", "idea-whitespace-quote"]);
    expect(out.issues).toEqual([
      { index: 1, id: "idea-bad-quote", reason: "quote-not-in-source:c1" },
      { index: 2, id: "idea-unknown-claim", reason: "unknown-claim:c9" },
      { index: 3, id: "idea-missing-fields", reason: "schema:claimIds" },
    ]);
  });

  it("reports a whole-response problem without inventing records", () => {
    expect(extractRecords("not json at all", { listKey: "ideas", schema: Idea })).toEqual({
      accepted: [],
      issues: [{ index: -1, reason: "malformed-json" }],
    });
    expect(extractRecords('{"underlying":[]}', { listKey: "ideas", schema: Idea })).toEqual({
      accepted: [],
      issues: [{ index: -1, reason: "missing-list:ideas" }],
    });
    // An empty list is a valid "nothing found", not an issue.
    expect(extractRecords('{"ideas":[]}', { listKey: "ideas", schema: Idea })).toEqual({
      accepted: [],
      issues: [],
    });
  });

  it("bounds the number of records and says so", () => {
    const many = { ideas: Array.from({ length: 4 }, (_, i) => idea({ id: `idea-${i}` })) };
    const out = extractRecords(JSON.stringify(many), {
      listKey: "ideas",
      schema: Idea,
      check,
      maxItems: 2,
    });
    expect(out.accepted).toHaveLength(2);
    expect(out.issues).toEqual([{ index: -1, reason: "truncated:2" }]);
  });

  it("matches quotations verbatim after whitespace normalisation only", () => {
    expect(quotedIn("making  people\nin the town", CLAIMS.c1!)).toBe(true);
    expect(quotedIn("making people in a town", CLAIMS.c1!)).toBe(false);
    expect(quotedIn("   ", CLAIMS.c1!)).toBe(false);
  });
});
