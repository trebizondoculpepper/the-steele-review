import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_PACKAGE_DRAFT_PROMPT,
  PACKAGE_REVISION_INSTRUCTIONS,
  PACKAGE_REVISION_PROMPT_VERSION,
} from "../../src/drafting/package-draft.js";
import { loadPromptFile } from "../../src/prompt-files.js";

/**
 * Editorial copy definitions (#468): the owner's house style for title,
 * subtitle, excerpt and body must appear in both the first-draft and revision
 * prompt contracts.
 */
describe("editorial copy contracts (#468)", () => {
  it("defines title, subtitle, excerpt and body in the first-draft prompt", () => {
    const text = DEFAULT_PACKAGE_DRAFT_PROMPT.instructions;
    expect(text).toContain("short, pithy hook that teases the article accurately");
    expect(text).toContain("adds a reason to read rather than repeating the title");
    expect(text).toContain("poses the central question");
    expect(text).toContain("three-sentence summary of the article");
    expect(text).toContain("distinct from a quotation");
    expect(text).toMatch(/editorial (target|aim)/);
    expect(text).toContain("never pad a thin evidence package");
  });

  it("keeps the same definitions in the revision contract", () => {
    expect(PACKAGE_REVISION_INSTRUCTIONS).toContain("short, pithy hook");
    expect(PACKAGE_REVISION_INSTRUCTIONS).toContain("adds a reason to read");
    expect(PACKAGE_REVISION_INSTRUCTIONS).toContain("three-sentence summary");
    expect(PACKAGE_REVISION_INSTRUCTIONS).toContain("never a reason to pad thin evidence");
  });

  it("uses content-hashed identities so edited copy is not silently reused", () => {
    expect(DEFAULT_PACKAGE_DRAFT_PROMPT.version).toMatch(
      /^writer-package-explainer-sha256:[0-9a-f]{64}$/,
    );
    expect(PACKAGE_REVISION_PROMPT_VERSION).toMatch(
      /^writer-package-revision-sha256:[0-9a-f]{64}$/,
    );
    expect(loadPromptFile("writer", "package-explainer").version).toBe(
      DEFAULT_PACKAGE_DRAFT_PROMPT.version,
    );
  });
});
