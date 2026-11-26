import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { versions } from "./capture.js";
import { FakeModel, OpenRouterModel } from "../../writing/model.js";
import { AttemptStore } from "../../writing/store.js";
import { createAttempt, modelPhase, pinPhase, savePhase, StopError, type WritingDeps } from "../../writing/run.js";

/**
 * One-pass summary and critique (#921), as native Mastra workflows. Each
 * run shows three visible steps (pin-source, write, save-article) with
 * their inputs, outputs, timing and failure reason.
 *
 * - `start-writing` {version, mode}: a new attempt pinned to that exact
 *   retained version. It is also the deliberate rerun: every start gets a
 *   fresh attempt ID, including for an older version.
 * - `retry-writing` {attempt}: resumes an interrupted attempt. Saved model
 *   output is reused, so a retry never pays for a second call.
 * - `list-attempts` and `read-article`: read-only views.
 *
 * Live model calls need STEELE_EXP_MASTRA_LIVE_MODEL_ENABLED=1, an explicit
 * `mode: "live"`, and room within the live call limit and budget.
 */

const env = process.env;
export const attempts = new AttemptStore(env.STEELE_EXP_MASTRA_ARTICLES_DB ?? "file:./.data/articles.db");
const deps: WritingDeps = {
  attempts,
  versions,
  model: (mode) => (mode === "live" ? new OpenRouterModel(env.STEELE_EXP_MASTRA_MODEL_KEY_FILE ?? "/run/model/key.toml") : new FakeModel()),
  limits: {
    liveEnabled: env.STEELE_EXP_MASTRA_LIVE_MODEL_ENABLED === "1",
    maxLiveCalls: Number(env.STEELE_EXP_MASTRA_MAX_LIVE_CALLS ?? 1),
    liveBudgetUsd: Number(env.STEELE_EXP_MASTRA_LIVE_BUDGET_USD ?? 0.05),
    estimatedLiveCallUsd: 0.01,
  },
};

const visible = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    // The stopping reason becomes the step's visible error; the attempt keeps it too.
    throw new Error(e instanceof StopError ? `stopped: ${e.reason}` : String(e instanceof Error ? e.message : e));
  }
};

const AttemptRef = z.object({ attempt: z.string() });
const Any = z.record(z.string(), z.unknown());

const pin = createStep({
  id: "pin-source",
  description: "Read the exact retained source version from storage and pin it for this attempt.",
  inputSchema: AttemptRef,
  outputSchema: Any,
  execute: async ({ inputData }) => visible(() => pinPhase(deps, inputData.attempt)),
});
const write = createStep({
  id: "write",
  description: "One bounded model call with the shared prompt, or reuse of saved output on retry.",
  inputSchema: Any,
  outputSchema: Any,
  execute: async ({ inputData }) => visible(() => modelPhase(deps, String(inputData.attempt))),
});
const save = createStep({
  id: "save-article",
  description: "Validate against article-v1, render deterministic Markdown, and save the immutable article.",
  inputSchema: Any,
  outputSchema: Any,
  execute: async ({ inputData }) => visible(() => savePhase(deps, String(inputData.attempt))),
});

const create = createStep({
  id: "create-attempt",
  description: "Create a fresh attempt pinned to the selected source version.",
  inputSchema: z.object({ version: z.string().max(200), mode: z.enum(["fake", "live"]).default("fake") }),
  outputSchema: AttemptRef,
  execute: async ({ inputData }) => visible(async () => ({ attempt: await createAttempt(deps, inputData.version, inputData.mode) })),
});

export const startWritingWorkflow = createWorkflow({
  id: "start-writing",
  description: "Start (or deliberately rerun) one summary-and-critique attempt on a selected retained version (#921).",
  inputSchema: z.object({ version: z.string().max(200), mode: z.enum(["fake", "live"]).default("fake") }),
  outputSchema: Any,
})
  .then(create)
  .then(pin)
  .then(write)
  .then(save)
  .commit();

export const retryWritingWorkflow = createWorkflow({
  id: "retry-writing",
  description: "Resume an interrupted attempt; completed model output is reused, never re-charged (#921).",
  inputSchema: AttemptRef,
  outputSchema: Any,
})
  .then(pin)
  .then(write)
  .then(save)
  .commit();

export const listAttemptsWorkflow = createWorkflow({
  id: "list-attempts",
  description: "Read-only: recent writing attempts with status, source version, model, usage and stopping reason (#921).",
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  outputSchema: z.object({ attempts: z.array(Any), live: Any }),
})
  .then(
    createStep({
      id: "list-attempts",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      outputSchema: z.object({ attempts: z.array(Any), live: Any }),
      execute: async ({ inputData }) => ({
        attempts: (await attempts.list(inputData.limit)).map(({ rawOutput: _r, ...a }) => a as unknown as Record<string, unknown>),
        live: (await attempts.liveLedger()) as unknown as Record<string, unknown>,
      }),
    }),
  )
  .commit();

export const readArticleWorkflow = createWorkflow({
  id: "read-article",
  description: "Read-only: one saved article (Markdown and structured output) and its provenance (#921).",
  inputSchema: z.object({ article: z.string().max(300) }),
  outputSchema: Any,
})
  .then(
    createStep({
      id: "read-article",
      inputSchema: z.object({ article: z.string().max(300) }),
      outputSchema: Any,
      execute: async ({ inputData }) => {
        const a = await attempts.article(inputData.article);
        if (!a) throw new Error("not-found: no such article");
        return a as unknown as Record<string, unknown>;
      },
    }),
  )
  .commit();
