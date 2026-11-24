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
    expect(reason(artifact({ schemaVersion: 2 }))).toBe("schema-version:2");
    expect(reason(artifact({ stage: "check-coverage" }))).toBe("stage:check-coverage");
    expect(reason(artifact({ runId: "run-b" }))).toBe("run:run-b");
    expect(reason(artifact({ identity: "" }))).toBe("identity-missing");
    expect(reason(artifact(), `sha256:${"b".repeat(64)}`)).toBe("identity-mismatch");
  });

  it("rejects a malformed payload even with the expected identity", () => {
    expect(reason(artifact({ value: { ideas: [{ id: "idea-1" }] } }), ID)).toBe(
      "payload:ideas.0.claimIds",
    );
    expect(reason(artifact({ value: null }), ID)).toBe("payload:root");
  });
});
