import { describe, expect, it } from "vite-plus/test";
import { writerMechanicalPolicy } from "../../src/drafting/mechanical-policy.js";
import {
  fieldRepairRequest,
  mergeFieldPatch,
  metadataFieldRepair,
} from "../../src/drafting/field-repair.js";

describe("mechanical repair configuration and isolation", () => {
  it("defaults to three total turns and reads bounded explicit settings", () => {
    expect(writerMechanicalPolicy({})).toEqual({ maxTurns: 3, deadlineMs: 300000 });
    expect(
      writerMechanicalPolicy({ STEELE_WRITER_TURN_LIMIT: "2", STEELE_WRITER_DEADLINE_MS: "1000" }),
    ).toEqual({ maxTurns: 2, deadlineMs: 1000 });
    expect(() => writerMechanicalPolicy({ STEELE_WRITER_TURN_LIMIT: "100" })).toThrow();
  });
  it("isolates all invalid metadata fields and keeps nested failures on explicit fallback", () => {
    const candidate = {
      title: 3,
      excerpt: "bad",
      responses: [{ text: "unchanged", evidence: [0] }],
    };
    const repair = metadataFieldRepair(candidate, [
      { code: "invalid_type", path: ["title"] },
      { code: "too_big", path: ["excerpt"], maximum: 500 },
    ])!;
    expect(Object.keys(fieldRepairRequest(repair).invalidFields)).toEqual(["title", "excerpt"]);
    const merged = mergeFieldPatch(repair, { title: "Title", excerpt: "Summary" });
    expect(merged?.responses).toBe(candidate.responses);
    expect(
      mergeFieldPatch(repair, { title: "Title", excerpt: "Summary", responses: [] }),
    ).toBeUndefined();
    expect(
      metadataFieldRepair(candidate, [{ code: "invalid_type", path: ["responses", 0, "text"] }]),
    ).toBeUndefined();
  });
});
