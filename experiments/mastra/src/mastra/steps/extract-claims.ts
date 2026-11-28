import { createStep } from "@mastra/core/workflows";
import { z } from "zod";

import { GitRepository } from "../../common/git/index.js";
import { OpenRouterChat } from "../../common/model/openrouter.js";
import { collectionsRoot } from "../../collections/paths.js";
import { DEFAULT_CLAIM_MODEL, extractClaims, type ExtractOptions } from "../../claims/extract.js";
import { ProposeThemesInput } from "./propose-themes.js";

/**
 * Extract grounded claim utterances from one retained source (#961), as its
 * own step. Input is the exact raw-content record (path and commit). Output
 * exposes the outcome, saved claims, rejected candidates, warnings, usage and
 * timings.
 */

export const ExtractClaimsInput = ProposeThemesInput;

export const ExtractClaimsOutput = z.object({
  operation: z.string(),
  outcome: z.enum(["proposed", "partial", "none-valid", "skipped", "model-failed"]),
  reused: z.boolean(),
  reason: z.string().optional(),
  claims: z.array(z.object({ claimId: z.string(), quote: z.string(), path: z.string() })),
  rejected: z.array(z.object({ rank: z.number(), reason: z.string() })),
  warnings: z.array(z.string()),
  usage: z.object({ promptTokens: z.number().nullable(), completionTokens: z.number().nullable(), costUsd: z.number().nullable() }).nullable(),
  timings: z.object({ startedAt: z.string(), finishedAt: z.string(), modelMs: z.number().nullable(), totalMs: z.number() }),
  commit: z.string().optional(),
});

export function claimOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ExtractOptions {
  const root = collectionsRoot(env);
  if (!root) throw new Error("set STEELE_APP_DIR or STEELE_COLLECTIONS_ROOT");
  return {
    repo: new GitRepository(root),
    model: new OpenRouterChat(env.STEELE_EXP_MASTRA_MODEL_KEY_FILE ?? "/run/model/key.toml"),
    modelId: env.STEELE_CLAIM_MODEL || DEFAULT_CLAIM_MODEL,
  };
}

export function createExtractClaimsStep(options: () => ExtractOptions = () => claimOptionsFromEnv()) {
  return createStep({
    id: "extract-claims",
    description: "Extract grounded claim utterances (verbatim quotes with location, speaker and date) from one exact retained source version.",
    inputSchema: ExtractClaimsInput,
    outputSchema: ExtractClaimsOutput,
    execute: async ({ inputData }) => extractClaims(inputData, options()),
  });
}

export const extractClaimsStep = createExtractClaimsStep();
