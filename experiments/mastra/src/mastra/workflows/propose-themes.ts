import { createWorkflow } from "@mastra/core/workflows";

import { ProposeThemesInput, ProposeThemesOutput, proposeThemesStep } from "../steps/propose-themes.js";

/**
 * Propose Themes (#960): the theme step run on its own for one retained
 * source, given the raw-content record's path and the commit to read it at.
 * Manually triggered.
 */
export const proposeThemesWorkflow = createWorkflow({
  id: "Propose Themes",
  description: "Propose Themes: one bounded model call proposes grounded themes for a single retained source version (raw_content path and commit).",
  inputSchema: ProposeThemesInput,
  outputSchema: ProposeThemesOutput,
})
  .then(proposeThemesStep)
  .commit();
