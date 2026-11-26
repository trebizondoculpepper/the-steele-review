import { createHash, randomBytes } from "node:crypto";
import type { VersionStore } from "../capture/store.js";
import { ModelError, type WritingModel } from "./model.js";
import { loadWritingPrompt, renderUser, type WritingPrompt } from "./prompt.js";
import { ArticleSchema, lengthGuidance, renderArticle, unsupportedMarkdown } from "./render.js";
import type { AttemptStore } from "./store.js";

/**
 * One bounded writing attempt (#921): one pinned source version, one model
 * call, one validated and saved article. No research, no judge, no
 * correction loop.
 *
 * Phases are idempotent and read their state from the store:
 * - pin: read the exact retained version from storage (never the source).
 * - model: call the model once, or reuse saved output on retry.
 * - save: validate against article-v1, render, save the immutable article.
 */

export const PLATFORM = "mastra";
export const MAX_SOURCE_CHARS = 60_000;

export interface WritingDeps {
  attempts: AttemptStore;
  versions: VersionStore;
  model: (mode: "fake" | "live") => WritingModel;
  prompt?: WritingPrompt;
  limits: { maxLiveCalls: number; liveBudgetUsd: number; estimatedLiveCallUsd: number; liveEnabled: boolean };
  now?: () => Date;
}

/** Model calls in flight in this process. A `calling` attempt absent from here was interrupted by a restart. */
const inFlight = new Set<string>();

export class StopError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export function newAttemptId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${PLATFORM}-${stamp}-${randomBytes(2).toString("hex")}`;
}

const stamp = (d: WritingDeps) => (d.now ?? (() => new Date()))().toISOString();

/** Creates a new attempt pinned to `sourceVersion`. Starting or rerunning always gets a fresh attempt ID. */
export async function createAttempt(deps: WritingDeps, sourceVersion: string, mode: "fake" | "live"): Promise<string> {
  await deps.versions.read(sourceVersion); // must exist and verify before an attempt is created
  if (mode === "live" && !deps.limits.liveEnabled) throw new StopError("live-model-disabled");
  const attempt = newAttemptId((deps.now ?? (() => new Date()))());
  await deps.attempts.create({ attempt, sourceVersion, mode, promptIdentity: (deps.prompt ?? loadWritingPrompt()).identity }, stamp(deps));
  return attempt;
}

async function load(deps: WritingDeps, attempt: string) {
  const a = await deps.attempts.get(attempt);
  if (!a) throw new StopError("unknown-attempt");
  return a;
}

async function stop(deps: WritingDeps, attempt: string, reason: string): Promise<never> {
  await deps.attempts.fail(attempt, reason, stamp(deps));
  throw new StopError(reason);
}

/** Phase 1: pin the exact retained version. */
export async function pinPhase(deps: WritingDeps, attempt: string) {
  const a = await load(deps, attempt);
  const v = await deps.versions.read(a.sourceVersion);
  if (a.status === "failed") throw new StopError(a.error ?? "failed");
  if (!v.bundle.text.trim()) return stop(deps, attempt, "no-usable-text");
  if (v.bundle.text.length > MAX_SOURCE_CHARS) return stop(deps, attempt, "source-too-large");
  return { attempt, sourceVersion: v.version, sourceSha256: v.sha256, title: v.bundle.title, medium: v.bundle.medium, textChars: v.bundle.text.length, sourceWarnings: v.warnings };
}

/** Phase 2: one model call, or reuse of saved output. */
export async function modelPhase(deps: WritingDeps, attempt: string) {
  let a = await load(deps, attempt);
  let called = false;
  if (a.status === "failed") throw new StopError(a.error ?? "failed");
  if (a.status === "calling") {
    // Still running here: report it without touching the attempt.
    if (inFlight.has(attempt)) throw new StopError("model-call-in-progress");
    // The process stopped mid-call. A live call may have been charged: never resend it.
    if (a.mode === "live") return stop(deps, attempt, "provider-uncertain");
    await deps.attempts.fail(attempt, "interrupted-fake-call", stamp(deps));
    throw new StopError("interrupted-fake-call");
  }
  if (a.status === "pending") {
    // Live permission is rechecked at the call boundary, not only at creation.
    if (a.mode === "live" && !deps.limits.liveEnabled) return stop(deps, attempt, "live-model-disabled");
    const prompt = deps.prompt ?? loadWritingPrompt();
    if (prompt.identity !== a.promptIdentity) return stop(deps, attempt, "prompt-changed-since-attempt-created");
    const v = await deps.versions.read(a.sourceVersion);
    const user = renderUser(prompt.userTemplate, { title: v.bundle.title, medium: v.bundle.medium, publishedAt: v.bundle.publishedAt, text: v.bundle.text });
    const begun = await deps.attempts.beginModelCall(
      attempt,
      stamp(deps),
      a.mode === "live" ? { maxCalls: deps.limits.maxLiveCalls, budgetUsd: deps.limits.liveBudgetUsd, estimateUsd: deps.limits.estimatedLiveCallUsd } : undefined,
    );
    if (begun === "call-limit") return stop(deps, attempt, "budget-exceeded: live call limit reached");
    if (begun === "budget") return stop(deps, attempt, "budget-exceeded: live budget");
    if (begun !== "started") throw new StopError("model-call-already-started");
    called = true;
    inFlight.add(attempt);
    try {
      const out = await deps.model(a.mode).complete(prompt.system, user);
      await deps.attempts.saveModelOutput(
        attempt,
        { model: out.model, raw: out.raw, usage: { ...out.usage, provider: out.provider }, costUsd: out.usage.costUsd, finishReason: out.finishReason },
        stamp(deps),
      );
    } catch (e) {
      return stop(deps, attempt, e instanceof ModelError ? e.code : "provider-error");
    } finally {
      inFlight.delete(attempt);
    }
    a = await load(deps, attempt);
  }
  return { attempt, mode: a.mode, model: a.model, promptIdentity: a.promptIdentity, usage: a.usage, costUsd: a.costUsd, finishReason: a.finishReason, reused: !called };
}

/** Phase 3: validate, render and save the immutable article. */
export async function savePhase(deps: WritingDeps, attempt: string) {
  const a = await load(deps, attempt);
  if (a.status === "saved" && a.articleId) return { attempt, articleId: a.articleId, alreadySaved: true };
  if (a.status !== "model-done" || a.rawOutput === null) throw new StopError(a.error ?? `not-ready (${a.status})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(a.rawOutput);
  } catch {
    return stop(deps, attempt, "invalid-model-output: not JSON");
  }
  const checked = ArticleSchema.safeParse(parsed);
  if (!checked.success) return stop(deps, attempt, `invalid-model-output: ${checked.error.issues[0]?.path.join(".") || "schema"}`);
  const article = checked.data;
  const unsupported = unsupportedMarkdown(article);
  if (unsupported) return stop(deps, attempt, `invalid-model-output: unsupported-markdown (${unsupported})`);
  const length = lengthGuidance(article);
  // Advisory only: added while within the article's 10-warning limit; the counts are always recorded.
  if (length.warning && !article.warnings.includes(length.warning) && article.warnings.length < 10) article.warnings.push(length.warning);
  const markdown = renderArticle(article);
  const articleId = `${attempt}/article@sha256:${createHash("sha256").update(markdown).digest("hex")}`;
  await deps.attempts.saveArticle(
    {
      articleId,
      attempt,
      sourceVersion: a.sourceVersion,
      title: article.title,
      subtitle: article.subtitle ?? null,
      markdown,
      articleJson: JSON.stringify({ ...article, lengthGuidance: length }),
      promptIdentity: a.promptIdentity,
      model: a.model ?? "unknown",
    },
    stamp(deps),
  );
  return { attempt, articleId, alreadySaved: false, warnings: article.warnings, summaryWords: length.summaryWords };
}
