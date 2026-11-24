import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as restate from "@restatedev/restate-sdk";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import { ModelProviderError } from "../controllers/openrouter.js";

/**
 * The shared model step for Corpus Refinement (#835), first half of the
 * composable stage (#833): prepare a request from pinned data and a versioned
 * Markdown prompt, then make exactly one named, durable Restate operation per
 * outbound request. Replay returns the recorded response instead of calling
 * the provider again. Extraction and validation (#836) and the workflow's
 * policy (saving, deferral, repair) stay with the caller.
 *
 * Prompts live in this feature's `prompts/` directory (owner-approved
 * exception, doc/architecture/19-themes-and-dossiers.md).
 */

export interface StagePrompt {
  /** Prompt identity: name plus the content hash, recorded with every call. */
  version: string;
  instructions: string;
}

const PROMPT_NAME = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** Loads one prompt from the feature's `prompts/` directory. */
export function loadStagePrompt(name: string): StagePrompt {
  if (!PROMPT_NAME.test(name)) throw new Error("invalid prompt name");
  let instructions: string;
  try {
    instructions = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8").trim();
  } catch {
    // Name the prompt, never the filesystem path.
    throw new Error(`corpus-refinement prompt missing: ${name}.md`);
  }
  if (!instructions) throw new Error(`corpus-refinement prompt is empty: ${name}.md`);
  const hash = createHash("sha256").update(instructions).digest("hex");
  return { version: `corpus-refinement-${name}-sha256:${hash}`, instructions };
}

/** One prepared outbound request, built only from pinned data. */
export interface PreparedRequest {
  system: string;
  user: string;
  maxOutputChars: number;
  promptVersion: string;
}

/** Binds pinned stage input to a prompt. The input is data, never instructions. */
export function prepareRequest(
  prompt: StagePrompt,
  input: unknown,
  maxOutputChars = 24_000,
): PreparedRequest {
  return {
    system: prompt.instructions,
    user: JSON.stringify(input),
    maxOutputChars,
    promptVersion: prompt.version,
  };
}

/** A recorded model response, as journaled by Restate. */
export interface RecordedResponse {
  text: string;
  promptVersion: string;
  model: string;
}

/** The Restate operation name for one outbound request of a stage. */
export const modelCallName = (stage: string, role?: string) =>
  role ? `${stage}:model:${role}` : `${stage}:model`;

/**
 * Makes one outbound request as a named, durable Restate operation and returns
 * the recorded response. Restate owns retries of transient failures; a
 * provider failure that retrying cannot fix ends the operation terminally.
 */
export async function callModel(
  ctx: restate.Context,
  provider: ExtractionModelProvider,
  name: string,
  request: PreparedRequest,
  timeoutMs = 180_000,
): Promise<RecordedResponse> {
  return ctx.run(name, async () => {
    try {
      const text = await provider.complete(
        { system: request.system, user: request.user, maxOutputChars: request.maxOutputChars },
        AbortSignal.timeout(timeoutMs),
      );
      return { text, promptVersion: request.promptVersion, model: provider.modelVersion };
    } catch (error) {
      if (error instanceof ModelProviderError && !error.retryable)
        throw new restate.TerminalError(`model call ${name} failed: ${error.code}`);
      throw error;
    }
  });
}
