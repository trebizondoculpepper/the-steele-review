import { ModelProviderError } from "../controllers/openrouter.js";
import { exportPipelineLog } from "../controllers/sentry-logs.js";
import { postCorrelationId } from "./post-correlation.js";

/**
 * Provider credit exhaustion as an operational condition (#407).
 *
 * The monetary control is the provider's own per-key budget, managed outside
 * the application. When it is exhausted, work must stop visibly and wait for
 * credit, never be recorded as an editorial result (no evidence, malformed
 * output, or a skipped claim). This module records the condition: a
 * sanitised local line on every occurrence, and a Sentry warning (the
 * `article.pipeline` milestone at warn level) deduplicated per stage within a
 * window, so a queue of stalled runs cannot flood Sentry. Nothing about the
 * key, prompt, endpoint or response is included.
 */

export const CREDIT_EXHAUSTED = "credit-exhausted";
export const CONDITION_WARNING_WINDOW_MS = 10 * 60_000;

/** True for a provider error that means the credit budget is exhausted. */
export function isCreditExhausted(error: unknown): error is ModelProviderError {
  return error instanceof ModelProviderError && error.code === "credit-exhausted";
}

/** Rethrow credit exhaustion at once: retrying cannot help until credit is restored. */
export function rethrowCreditExhausted(error: unknown): void {
  if (isCreditExhausted(error)) throw error;
}

const lastWarned = new Map<string, number>();

export function reportCreditExhausted(
  post: { publicationId: string; postId: string },
  stage: string,
  sourceVersion?: string,
  now: () => number = Date.now,
): { warned: boolean } {
  const attributes = {
    correlation_id: postCorrelationId(post),
    stage,
    outcome: CREDIT_EXHAUSTED,
    ...(/^sha256:[0-9a-f]{64}$/.test(sourceVersion ?? "") ? { revision: sourceVersion! } : {}),
  };
  console.warn(JSON.stringify({ event: "provider.condition", ...attributes }));
  const at = now();
  const last = lastWarned.get(stage);
  if (last !== undefined && at - last < CONDITION_WARNING_WINDOW_MS) return { warned: false };
  lastWarned.set(stage, at);
  exportPipelineLog(attributes, "warn");
  return { warned: true };
}

/** For tests. */
export function resetConditionWarnings(): void {
  lastWarned.clear();
}
