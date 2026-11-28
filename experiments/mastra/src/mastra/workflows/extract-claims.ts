import { createWorkflow } from "@mastra/core/workflows";

import { ExtractClaimsInput, ExtractClaimsOutput, extractClaimsStep } from "../steps/extract-claims.js";

/**
 * Extract Claims (#961): the claim step run on its own for one retained source,
 * given the raw-content record's path and the commit to read it at. Manually
 * triggered.
 */
export const extractClaimsWorkflow = createWorkflow({
  id: "Extract Claims",
  description: "Extract Claims: one bounded model call extracts grounded claim utterances from a single retained source version (raw_content path and commit).",
  inputSchema: ExtractClaimsInput,
  outputSchema: ExtractClaimsOutput,
})
  .then(extractClaimsStep)
  .commit();
