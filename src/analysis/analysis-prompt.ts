import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtractionPrompt } from "./extraction.js";

/**
 * Model-facing analysis prompts live in version-controlled Markdown under
 * `src/prompts/analysis/`, one file per prompt (AGENTS.md; #237, #421).
 *
 * The returned version embeds the file's content hash, so editing a prompt
 * changes the cache identity and the `promptVersion` saved with new results.
 * Existing artifacts keep their recorded version and stay readable; only new
 * work uses the new identity. Schemas, validation and binding of untrusted
 * runtime input stay in TypeScript.
 */
export function loadAnalysisPrompt(name: string): ExtractionPrompt {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(name)) {
    throw new Error("invalid analysis prompt name");
  }
  const url = new URL(`../prompts/analysis/${name}.md`, import.meta.url);
  let instructions: string;
  try {
    instructions = readFileSync(url, "utf8").trim();
  } catch {
    // Name the prompt, never the filesystem path.
    throw new Error(`analysis prompt file missing: ${name}.md`);
  }
  if (instructions.length === 0) {
    throw new Error(`analysis prompt file is empty: ${name}.md`);
  }
  const hash = createHash("sha256").update(instructions).digest("hex");
  return { version: `analysis-${name}-sha256:${hash}`, instructions };
}
