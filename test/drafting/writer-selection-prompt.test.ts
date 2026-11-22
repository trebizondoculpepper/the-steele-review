import { createHash } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { loadPromptFile } from "../../src/prompt-files.js";
import { DEFAULT_PACKAGE_DRAFT_PROMPT } from "../../src/drafting/package-draft.js";

it("loads focused selection guidance with content-bound initial and revision identities", () => {
  const initial = loadPromptFile("writer", "package-explainer");
  const revision = loadPromptFile("writer", "package-revision");
  expect(DEFAULT_PACKAGE_DRAFT_PROMPT).toEqual(initial);
  for (const [name, prompt] of [
    ["package-explainer", initial],
    ["package-revision", revision],
  ] as const) {
    expect(prompt.version).toBe(
      `writer-${name}-sha256:${createHash("sha256").update(prompt.instructions).digest("hex")}`,
    );
    expect(prompt.instructions).toContain("context, not a checklist");
    expect(prompt.instructions).toContain("omitted claims were researched or disproved");
    expect(prompt.instructions).toContain("Sources appendix");
  }
  expect(initial.instructions).toContain("independent evidence directly answers");
  expect(revision.instructions).toContain("concise replacement or deletion");
});
