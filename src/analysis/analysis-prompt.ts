/**
 * Analysis prompts load from `src/prompts/analysis/` through the shared
 * prompt-file loader (`src/prompt-files.ts`). This re-export keeps the
 * analysis-specific name and its historical `analysis-<name>-sha256:` version
 * prefix used by cache identities.
 */
export { loadAnalysisPrompt } from "../prompt-files.js";
