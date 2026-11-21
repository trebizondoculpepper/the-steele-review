import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Model-facing prompts live in version-controlled Markdown under
 * `src/prompts/<service>/`, one file per prompt (AGENTS.md; #237, #421).
 *
 * The returned version embeds the file's content hash, so editing a prompt
 * changes the cache identity and the `promptVersion` saved with new results.
 * Existing artifacts keep their recorded version and stay readable; only new
 * work uses the new identity. Schemas, validation and binding of untrusted
 * runtime input stay in TypeScript.
 */
export interface PromptFile {
  version: string;
  instructions: string;
}

const SERVICE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function loadPromptFile(service: string, name: string): PromptFile {
  if (!SERVICE.test(service) || !NAME.test(name)) {
    throw new Error("invalid prompt file name");
  }
  const url = new URL(`./prompts/${service}/${name}.md`, import.meta.url);
  let instructions: string;
  try {
    instructions = readFileSync(url, "utf8").trim();
  } catch {
    // Name the prompt, never the filesystem path.
    throw new Error(`prompt file missing: ${service}/${name}.md`);
  }
  if (instructions.length === 0) {
    throw new Error(`prompt file is empty: ${service}/${name}.md`);
  }
  const hash = createHash("sha256").update(instructions).digest("hex");
  return { version: `${service}-${name}-sha256:${hash}`, instructions };
}

/** Analysis prompts keep their historical identity prefix. */
export const loadAnalysisPrompt = (name: string): PromptFile => loadPromptFile("analysis", name);
