import { describe, expect, it } from "vite-plus/test";
import { CorpusRefinementInputSchema } from "../../src/corpus-refinement/contracts.js";
import {
  SEED_CATALOGUE,
  UnderlyingCatalogueSchema,
} from "../../src/corpus-refinement/catalogue.js";
import { extractRecords } from "../../src/corpus-refinement/model-step.js";
import { ideasToUnderlyingSpec } from "../../src/corpus-refinement/steps/map-ideas-to-underlying-ideas.js";

// Synthetic ideas and model responses only: no model calls (#852).
const ideas = {
  ideas: [
    { id: "idea-bridge-guns", claimIds: ["c1"], statement: "Bridges hide guns aimed at drivers." },
    { id: "idea-tunnel-guns", claimIds: ["c2"], statement: "Tunnels hide turrets." },
    { id: "idea-road-fumes", claimIds: ["c3"], statement: "Road fumes cause memory loss." },
    { id: "idea-rail-hum", claimIds: ["c4"], statement: "Rail hum causes headaches." },
    { id: "idea-masts-poison", claimIds: ["c5"], statement: "Masts are built to poison towns." },
    {
      id: "idea-bypass-poison",
      claimIds: ["c6"],
      statement: "The bypass was routed to sicken us.",
    },
    { id: "idea-cameras-safety", claimIds: ["c7"], statement: "Speed cameras track everyone." },
    { id: "idea-barriers-safety", claimIds: ["c8"], statement: "New barriers log plates." },
  ],
};
const group = (id: string, ideaIds: string[], match: unknown) => ({
  id,
  statement: `statement for ${id}`,
  ideaIds,
  rationale: "why",
  match,
});
const run = (underlying: unknown[]) => {
  const spec = ideasToUnderlyingSpec(ideas, SEED_CATALOGUE);
  return extractRecords(JSON.stringify({ underlying }), {
    listKey: spec.listKey,
    schema: spec.schema,
    check: spec.check!,
  });
};

describe("reusing reviewed underlying ideas (#852)", () => {
  it("sends the pinned catalogue to the mapper as data", () => {
    const spec = ideasToUnderlyingSpec(ideas, SEED_CATALOGUE);
    const input = spec.input as { catalogue: { id: string; definition: string }[] };
    expect(input.catalogue.map((e) => e.id)).toContain("transport-infrastructure-causes-illness");
    expect(input.catalogue[0]!.definition).toBeTruthy();
  });

  it("keeps an exact fit under its stable catalogue ID", () => {
    const out = run([
      group(
        "hidden-weapons-in-transport-infrastructure",
        ["idea-bridge-guns", "idea-tunnel-guns"],
        { decision: "reuse", catalogueId: "hidden-weapons-in-transport-infrastructure" },
      ),
    ]);
    expect(out.issues).toEqual([]);
    expect(out.accepted[0]!.match).toEqual({
      decision: "reuse",
      catalogueId: "hidden-weapons-in-transport-infrastructure",
    });
  });

  it("keeps deliberate harm apart from incidental harm", () => {
    const out = run([
      group("transport-infrastructure-causes-illness", ["idea-road-fumes", "idea-rail-hum"], {
        decision: "reuse",
        catalogueId: "transport-infrastructure-causes-illness",
      }),
      // Intended harm is a different idea: proposed as new, not folded in.
      group("infrastructure-built-to-harm", ["idea-masts-poison", "idea-bypass-poison"], {
        decision: "new",
      }),
    ]);
    expect(out.issues).toEqual([]);
    expect(out.accepted.map((g) => [g.id, g.match?.decision])).toEqual([
      ["transport-infrastructure-causes-illness", "reuse"],
      ["infrastructure-built-to-harm", "new"],
    ]);
  });

  it("records an uncertain match with its candidates", () => {
    const out = run([
      group("cameras-and-barriers-watch-drivers", ["idea-cameras-safety", "idea-barriers-safety"], {
        decision: "uncertain",
        candidates: ["safety-measures-as-pretext-for-monitoring"],
      }),
    ]);
    expect(out.issues).toEqual([]);
    expect(out.accepted[0]!.match).toEqual({
      decision: "uncertain",
      candidates: ["safety-measures-as-pretext-for-monitoring"],
    });
  });

  it("rejects unknown, mismatched, colliding and repeated catalogue IDs", () => {
    const out = run([
      group("made-up", ["idea-bridge-guns", "idea-tunnel-guns"], {
        decision: "reuse",
        catalogueId: "made-up",
      }),
      group("other-id", ["idea-road-fumes", "idea-rail-hum"], {
        decision: "reuse",
        catalogueId: "transport-infrastructure-causes-illness",
      }),
      group("evidence-altered-or-deleted", ["idea-masts-poison", "idea-bypass-poison"], {
        decision: "new",
      }),
      group("watchers", ["idea-cameras-safety", "idea-barriers-safety"], {
        decision: "uncertain",
        candidates: ["no-such-entry"],
      }),
      // No match at all, though a catalogue was supplied.
      {
        id: "unmatched",
        statement: "s",
        ideaIds: ["idea-bridge-guns", "idea-rail-hum"],
        rationale: "r",
      },
    ]);
    expect(out.accepted).toEqual([]);
    expect(out.issues.map((i) => i.reason)).toEqual([
      "unknown-catalogue-id:made-up",
      "reuse-id-mismatch:other-id",
      "new-id-in-catalogue:evidence-altered-or-deleted",
      "unknown-catalogue-id:no-such-entry",
      "schema:match",
    ]);
  });

  it("lets only one group reuse a catalogue entry", () => {
    const reuse = { decision: "reuse", catalogueId: "transport-infrastructure-causes-illness" };
    const out = run([
      group("transport-infrastructure-causes-illness", ["idea-road-fumes", "idea-rail-hum"], reuse),
      group(
        "transport-infrastructure-causes-illness",
        ["idea-masts-poison", "idea-bypass-poison"],
        reuse,
      ),
    ]);
    expect(out.accepted).toHaveLength(1);
    expect(out.issues[0]!.reason).toBe(
      "catalogue-id-in-two-groups:transport-infrastructure-causes-illness",
    );
  });

  it("validates the seed catalogue and rejects duplicate entry IDs", () => {
    expect(UnderlyingCatalogueSchema.safeParse(SEED_CATALOGUE).success).toBe(true);
    const twice = {
      ...SEED_CATALOGUE,
      entries: [...SEED_CATALOGUE.entries, SEED_CATALOGUE.entries[0]],
    };
    expect(UnderlyingCatalogueSchema.safeParse(twice).success).toBe(false);
  });

  it("accepts only full commit hashes for the pinned catalogue, as the store does", () => {
    const input = (commit: string) =>
      CorpusRefinementInputSchema.safeParse({
        runId: "run-a",
        mode: "archive",
        claims: [{ id: "c1", statement: "s" }],
        catalogue: { repository: "r", commit, path: "p", sha256: "a".repeat(64) },
      }).success;
    expect(input("a".repeat(40))).toBe(true);
    expect(input("a".repeat(64))).toBe(true);
    expect(input("abc1234")).toBe(false);
  });
});
