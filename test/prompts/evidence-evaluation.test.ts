import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_PACKAGE_DRAFT_PROMPT,
  PACKAGE_REVISION_INSTRUCTIONS,
  PACKAGE_REVISION_PROMPT_VERSION,
} from "../../src/drafting/package-draft.js";

/**
 * Source-evaluation guidance (#485): woven into the writer prompts naturally,
 * with no CRAAP acronym, checklist, score or mandatory section.
 */
describe("source evaluation in the writer prompts (#485)", () => {
  const first = DEFAULT_PACKAGE_DRAFT_PROMPT.instructions;

  it("asks for currency, relevance, expertise and traceability", () => {
    expect(first).toContain("current enough for this particular claim");
    expect(first).toContain("directly address the claim");
    expect(first).toContain("relevant expertise");
    expect(first).toContain("traced to the original source");
  });

  it("keeps an older source valid and a recent one insufficient on its own", () => {
    // Synthetic case: older but still relevant primary evidence.
    expect(first).toContain("An older source is not automatically invalid");
    // Synthetic case: contemporary but irrelevant or prestigious evidence.
    expect(first).toContain("does not automatically answer a claim");
  });

  it("forbids inventing motive when author or purpose is unknown", () => {
    // Synthetic case: missing author/purpose information.
    expect(first).toContain("never infer motives or financial ties");
    expect(first).toContain("never treat purpose or credentials as proof");
    expect(first).toContain("only where the supplied evidence makes them relevant");
  });

  it("carries the same guidance into the revision prompt", () => {
    expect(PACKAGE_REVISION_INSTRUCTIONS).toContain("current enough for this particular claim");
    expect(PACKAGE_REVISION_INSTRUCTIONS).toContain("An older source is not automatically invalid");
    expect(PACKAGE_REVISION_INSTRUCTIONS).toContain("never infer motives or financial ties");
  });

  it("keeps the prompt identity content-addressed, so the change is recorded", () => {
    expect(DEFAULT_PACKAGE_DRAFT_PROMPT.version).toMatch(/^writer-package-explainer-sha256:[0-9a-f]{64}$/);
    expect(PACKAGE_REVISION_PROMPT_VERSION).toMatch(/sha256:[0-9a-f]{64}$/);
  });

  it("introduces no acronym, score or mandatory evaluation section", () => {
    for (const text of [first, PACKAGE_REVISION_INSTRUCTIONS]) {
      expect(text).not.toMatch(/\bCRAAP\b/);
      expect(text).not.toMatch(/source-quality score/i);
      expect(text).not.toMatch(/evaluation table/i);
    }
  });
});
