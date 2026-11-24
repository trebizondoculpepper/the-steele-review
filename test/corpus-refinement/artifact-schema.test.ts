import { describe, expect, it } from "vite-plus/test";
import {
  CorpusArtifactError,
  readStageArtifact,
} from "../../src/corpus-refinement/artifact-schema.js";

// Pure parsing of synthetic artifacts; nothing is read or written (#848).
const ID = `sha256:${"a".repeat(64)}`;
const artifact = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    stage: "map-claims-to-ideas",
    runId: "run-a",
    identity: ID,
    value: { ideas: [{ id: "idea-1", claimIds: ["c1"] }] },
    ...over,
  });
const expected = { runId: "run-a", stage: "map-claims-to-ideas" as const };
const reason = (text: string, identity?: string) => {
  try {
    readStageArtifact(text, { ...expected, identity });
    return "accepted";
  } catch (error) {
    return error instanceof CorpusArtifactError ? error.reason : "other";
  }
};

describe("saved Corpus Refinement artifacts are validated before use (#848)", () => {
  it("accepts a well-formed artifact and returns its payload", () => {
    const out = readStageArtifact(artifact(), { ...expected, identity: ID });
    expect(out.value.ideas[0]!.id).toBe("idea-1");
  });

  it("rejects each kind of mismatch with a clear reason", () => {
    expect(reason("{not json")).toBe("malformed-json");
    expect(reason("[1,2]")).toBe("not-an-artifact");
    expect(reason(artifact({ schemaVersion: 2 }))).toBe("schema-version-mismatch");
    expect(reason(artifact({ stage: "check-coverage" }))).toBe("stage-mismatch");
    expect(reason(artifact({ runId: "run-b" }))).toBe("run-mismatch");
    expect(reason(artifact({ identity: "" }))).toBe("identity-missing");
    expect(reason(artifact(), `sha256:${"b".repeat(64)}`)).toBe("identity-mismatch");
  });

  it.each(["schemaVersion", "stage", "runId"])(
    "keeps invalid %s values out of diagnostics",
    (field) => {
      const marker = "synthetic-private-value";
      expect(() => readStageArtifact(artifact({ [field]: marker }), expected)).toThrow(
        CorpusArtifactError,
      );
      try {
        readStageArtifact(artifact({ [field]: marker }), expected);
      } catch (error) {
        expect(String(error)).not.toContain(marker);
      }
    },
  );

  it("rejects a malformed payload even with the expected identity", () => {
    expect(reason(artifact({ value: { ideas: [{ id: "idea-1" }] } }), ID)).toBe(
      "payload:ideas.0.claimIds",
    );
    expect(reason(artifact({ value: null }), ID)).toBe("payload:root");
  });

  it("keeps catalogue proposals and the pinned catalogue on read (#852)", () => {
    const catalogue = {
      repository: "r",
      commit: "a".repeat(40),
      path: "p",
      sha256: "b".repeat(64),
    };
    const text = JSON.stringify({
      schemaVersion: 1,
      stage: "map-ideas-to-underlying",
      runId: "run-a",
      identity: ID,
      value: {
        underlying: [
          {
            id: "g1",
            ideaIds: ["i1", "i2"],
            match: { decision: "reuse", catalogueId: "g1" },
          },
        ],
        catalogue,
      },
    });
    const out = readStageArtifact(text, { runId: "run-a", stage: "map-ideas-to-underlying" });
    expect(out.value.underlying[0]!.match).toEqual({ decision: "reuse", catalogueId: "g1" });
    expect(out.value.catalogue).toEqual(catalogue);
  });
});
