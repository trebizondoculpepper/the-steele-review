import { describe, it, expect } from "vite-plus/test";
import { parseJudgmentDocument } from "../../src/drafting/judgment-document.js";
import { fixtureProviders } from "../../src/workflow/article-fixture.js";
const doc = (decision = "REVISE", required = "Correct the factual scope.") =>
  `## Reasons\nMaterial scope error.\n## Required corrections\n${required}\n## Accepted minor observations\nOptional link-label change.\nDECISION: ${decision}`;
describe("complete judgment authority", () => {
  it("separates required corrections from reasons and optional observations", () => {
    expect(parseJudgmentDocument(doc())).toEqual({
      decision: "revise",
      reasons: "Material scope error.",
      requiredCorrections: "Correct the factual scope.",
      acceptedMinorObservations: "Optional link-label change.",
    });
  });
  it.each([
    doc("APPROVE"),
    doc() + "\nDECISION: APPROVE",
    doc().replace(
      "## Required corrections",
      "## Required corrections\nA change.\n## Required corrections",
    ),
    doc("REVISE", "None."),
  ])("rejects contradictory or ambiguous authority", (raw) => {
    expect(parseJudgmentDocument(raw)).toBeUndefined();
  });
  it("keeps the fixture's canonical no-corrections approval valid", async () => {
    const p = fixtureProviders();
    const raw = await p.models.judge!.complete(
      { system: "fixture", user: "fixture" },
      new AbortController().signal,
    );
    expect(parseJudgmentDocument(raw)?.decision).toBe("approve");
  });
});
