import { describe, expect, it } from "vite-plus/test";
import { allCandidatesRejected } from "../../src/corpus-refinement/contracts.js";
import { readStageArtifact } from "../../src/corpus-refinement/artifact-schema.js";
import { extractRecords } from "../../src/corpus-refinement/model-step.js";
import { z } from "zod";

describe("stages whose candidates are all rejected (#901)", () => {
  const schema = z
    .object({ id: z.string(), match: z.enum(["reuse", "new"]) })
    .strict();
  it("flags the exp-853-c45 shape: every candidate fails validation", () => {
    const outcome = extractRecords(
      JSON.stringify({
        underlying: [
          { id: "a", match: { decision: "reuse" } },
          { id: "b", match: "maybe" },
        ],
      }),
      { listKey: "underlying", schema },
    );
    expect(outcome.accepted).toHaveLength(0);
    expect(allCandidatesRejected(outcome)).toBe(true);
  });

  it("flags malformed output, but not a partial success or an empty result", () => {
    expect(
      allCandidatesRejected(
        extractRecords("not json", { listKey: "underlying", schema }),
      ),
    ).toBe(true);
    const partial = extractRecords(
      JSON.stringify({
        underlying: [
          { id: "a", match: "new" },
          { id: "b", match: 7 },
        ],
      }),
      { listKey: "underlying", schema },
    );
    expect(allCandidatesRejected(partial)).toBe(false);
    expect(
      allCandidatesRejected(
        extractRecords(JSON.stringify({ underlying: [] }), {
          listKey: "underlying",
          schema,
        }),
      ),
    ).toBe(false);
  });

  it("saves the flag in the rejected output and still reads older outputs without it", () => {
    const artifact = (value: object) =>
      JSON.stringify({
        schemaVersion: 1,
        stage: "map-ideas-to-underlying-rejected",
        runId: "r1",
        identity: "sha256:x",
        value,
      });
    const base = {
      from: "map-ideas-to-underlying",
      sent: 2,
      unplaced: ["idea-01", "idea-02"],
      issues: [{ index: 0, reason: "schema:match" }],
    };
    expect(
      readStageArtifact(artifact({ ...base, allRejected: true }), {
        runId: "r1",
        stage: "map-ideas-to-underlying-rejected",
      }).value,
    ).toMatchObject({ allRejected: true });
    expect(
      readStageArtifact(artifact(base), {
        runId: "r1",
        stage: "map-ideas-to-underlying-rejected",
      }).value,
    ).not.toHaveProperty("allRejected");
  });
});
