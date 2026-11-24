import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as restate from "@restatedev/restate-sdk";
import type { z } from "zod";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import { ModelProviderError } from "../controllers/openrouter.js";
import type { ExtractionOutcome, ItemIssue } from "./contracts.js";

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

/**
 * Extracts candidate records from a recorded response and validates each one
 * on its own (#836): JSON is parsed locally, then each item is checked against
 * the stage's schema and the stage's own evidence rules (source references,
 * quotations). Valid records are kept even when others fail; no model is used
 * to repair output, and no saving or repair decision is made here.
 */
export function extractRecords<T>(
  text: string,
  options: {
    /** The response key holding the candidate list, e.g. "ideas". */
    listKey: string;
    schema: z.ZodType<T>;
    /** Stage-supplied evidence rule: a reason to reject the item, or undefined. */
    check?: (item: T) => string | undefined;
    maxItems?: number;
  },
): ExtractionOutcome<T> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let parsed: unknown;
  try {
    parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || typeof parsed !== "object" || parsed === null)
    return { accepted: [], issues: [{ index: -1, reason: "malformed-json" }] };
  const list = (parsed as Record<string, unknown>)[options.listKey];
  if (!Array.isArray(list))
    return { accepted: [], issues: [{ index: -1, reason: `missing-list:${options.listKey}` }] };
  const max = options.maxItems ?? 500;
  const accepted: T[] = [];
  const issues: ItemIssue[] = [];
  if (list.length > max) issues.push({ index: -1, reason: `truncated:${list.length - max}` });
  list.slice(0, max).forEach((raw, index) => {
    const rawId =
      raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
        ? ((raw as { id: string }).id.slice(0, 200) as string)
        : undefined;
    const withId = (reason: string): ItemIssue => ({
      index,
      ...(rawId ? { id: rawId } : {}),
      reason,
    });
    const item = options.schema.safeParse(raw);
    if (!item.success) {
      const path = item.error.issues[0]?.path.join(".") || "item";
      issues.push(withId(`schema:${path}`));
      return;
    }
    const rejected = options.check?.(item.data);
    if (rejected) issues.push(withId(rejected));
    else accepted.push(item.data);
  });
  return { accepted, issues };
}

const normalise = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

/** Evidence rule helper: the quotation appears verbatim (whitespace-normalised) in the source. */
export const quotedIn = (quote: string, source: string) =>
  normalise(quote).length > 0 && normalise(source).includes(normalise(quote));

/** What one model-backed stage supplies to the shared stage function (#837). */
export interface ModelStageSpec<T> {
  /** Stage name; the durable call is named from it. */
  stage: string;
  prompt: StagePrompt;
  /** Pinned stage input, sent as data. */
  input: unknown;
  listKey: string;
  schema: z.ZodType<T>;
  check?: (item: T) => string | undefined;
  maxOutputChars?: number;
}

/** Result of one composed model stage: validated records plus provenance. */
export interface ModelStageResult<T> extends ExtractionOutcome<T> {
  promptVersion: string;
  model: string;
}

/**
 * The composable model stage (#833, #837): input preparation, one named
 * durable model call, local structured extraction and per-item validation.
 * Each mapping supplies its own prompt, schema and evidence rule; Restate owns
 * durability and retries; saving, deferral and repair stay with the workflow.
 */
export async function runModelStage<T>(
  ctx: restate.Context,
  provider: ExtractionModelProvider,
  spec: ModelStageSpec<T>,
): Promise<ModelStageResult<T>> {
  const request = prepareRequest(spec.prompt, spec.input, spec.maxOutputChars);
  const response = await callModel(ctx, provider, modelCallName(spec.stage), request);
  const outcome = extractRecords(response.text, {
    listKey: spec.listKey,
    schema: spec.schema,
    ...(spec.check ? { check: spec.check } : {}),
  });
  return { ...outcome, promptVersion: response.promptVersion, model: response.model };
}
