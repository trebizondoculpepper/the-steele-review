import { createStep } from "@mastra/core/workflows";
import { z } from "zod";

import { GitRepository } from "../../common/git/index.js";
import { OpenRouterChat } from "../../common/model/openrouter.js";
import { collectionsRoot } from "../../collections/paths.js";
import { DEFAULT_THEME_MODEL, proposeThemes, type ProposeOptions } from "../../themes/propose.js";

/**
 * Propose themes for one retained source (#960), as its own step. Input is the
 * exact raw-content record (path and commit). Output exposes the outcome,
 * saved theme IDs, rejected proposals, warnings, usage and timings.
 */

export const ProposeThemesInput = z.object({
  path: z.string().regex(/^raw_content\/[a-z0-9-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/article\.json$/),
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
});

export const ProposeThemesOutput = z.object({
  operation: z.string(),
  outcome: z.enum(["proposed", "partial", "none-valid", "skipped", "model-failed"]),
  reused: z.boolean(),
  reason: z.string().optional(),
  themes: z.array(z.object({ themeId: z.string(), title: z.string(), path: z.string() })),
  rejected: z.array(z.object({ rank: z.number(), reason: z.string() })),
  warnings: z.array(z.string()),
  usage: z.object({ promptTokens: z.number().nullable(), completionTokens: z.number().nullable(), costUsd: z.number().nullable() }).nullable(),
  timings: z.object({ startedAt: z.string(), finishedAt: z.string(), modelMs: z.number().nullable(), totalMs: z.number() }),
  commit: z.string().optional(),
});

export function themeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ProposeOptions {
  const root = collectionsRoot(env);
  if (!root) throw new Error("set STEELE_APP_DIR or STEELE_COLLECTIONS_ROOT");
  return {
    repo: new GitRepository(root),
    model: new OpenRouterChat(env.STEELE_EXP_MASTRA_MODEL_KEY_FILE ?? "/run/model/key.toml"),
    modelId: env.STEELE_THEME_MODEL || DEFAULT_THEME_MODEL,
  };
}

export function createProposeThemesStep(options: () => ProposeOptions = () => themeOptionsFromEnv()) {
  return createStep({
    id: "propose-themes",
    description: "Propose grounded themes for one exact retained source version; reuses a saved result for the same source, prompt and model.",
    inputSchema: ProposeThemesInput,
    outputSchema: ProposeThemesOutput,
    execute: async ({ inputData }) => proposeThemes(inputData, options()),
  });
}

export const proposeThemesStep = createProposeThemesStep();
