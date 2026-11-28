import { createHash } from "node:crypto";

import { ModelError, type ChatModel } from "../common/model/openrouter.js";
import { loadWritingPrompt } from "../writing/prompt.js";

/**
 * Narrow English-intelligibility check for a supplied transcript (#953).
 *
 * It judges the transcript text itself, not its language label, with one
 * small model call on a bounded sample (beginning and middle). A label that
 * disagrees with an intelligible English text is recorded as a mismatch, not
 * as a reason to skip. A provider failure is reported as `check-failed`, which
 * is distinct from a transcript judged unusable; the fetched content is kept
 * either way.
 */

export const PROMPT_NAME = "transcript-intelligibility-v1";
export const DEFAULT_CHECK_MODEL = "deepseek/deepseek-v4.1-flash";
const HEAD_CHARS = 1500;
const MIDDLE_CHARS = 1000;

export type Verdict = "intelligible-english" | "not-english" | "garbled";

export interface TranscriptCheck {
  status: "usable" | "unusable" | "check-failed";
  verdict?: Verdict;
  reason?: string;
  /** Provider failure category, when status is check-failed. */
  error?: string;
  languageLabel: string | null;
  labelMismatch: boolean;
  model: string;
  prompt: string;
  /** SHA-256 of the full transcript text the check applies to. */
  textSha256: string;
  usage?: { promptTokens: number | null; completionTokens: number | null; costUsd: number | null };
}

export function transcriptSample(text: string): string {
  if (text.length <= HEAD_CHARS + MIDDLE_CHARS) return text;
  const middle = Math.floor(text.length / 2 - MIDDLE_CHARS / 2);
  return `${text.slice(0, HEAD_CHARS)}\n[...]\n${text.slice(middle, middle + MIDDLE_CHARS)}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function checkTranscript(
  text: string,
  languageLabel: string | null,
  model: ChatModel,
  modelId = DEFAULT_CHECK_MODEL,
): Promise<TranscriptCheck> {
  const prompt = loadWritingPrompt(PROMPT_NAME);
  const base = { languageLabel, model: modelId, prompt: prompt.identity, textSha256: sha256(text), labelMismatch: false };
  const sample = transcriptSample(text).replaceAll("</transcript>", "&lt;/transcript>");
  let result;
  try {
    result = await model.complete({
      model: modelId,
      system: prompt.system,
      // A callback inserts the sample literally (no `$&`-style replacement patterns).
      user: prompt.userTemplate.replace("{{transcript.sample}}", () => sample),
      maxTokens: 120,
      temperature: 0,
      json: true,
      timeoutMs: 60_000,
    });
  } catch (error) {
    return { ...base, status: "check-failed", error: error instanceof ModelError ? error.code : "provider-error" };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { ...base, status: "check-failed", error: "invalid-model-output", usage: result.usage, model: result.model };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ...base, status: "check-failed", error: "invalid-model-output", usage: result.usage, model: result.model };
  const parsed = value as { verdict?: unknown; reason?: unknown };
  const verdict = parsed.verdict;
  if (verdict !== "intelligible-english" && verdict !== "not-english" && verdict !== "garbled")
    return { ...base, status: "check-failed", error: "invalid-model-output", usage: result.usage, model: result.model };
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : undefined;
  return {
    ...base,
    model: result.model,
    status: verdict === "intelligible-english" ? "usable" : "unusable",
    verdict,
    ...(reason ? { reason } : {}),
    labelMismatch: labelMismatch(verdict, languageLabel),
    usage: result.usage,
  };
}

/** Whether a language label disagrees with the verdict on the text (garbled text has no language). */
export function labelMismatch(verdict: Verdict, languageLabel: string | null): boolean {
  if (languageLabel === null || verdict === "garbled") return false;
  const labelSaysEnglish = /^en(\b|[-_])/i.test(languageLabel);
  return labelSaysEnglish !== (verdict === "intelligible-english");
}
