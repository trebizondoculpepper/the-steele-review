import { createStep } from "@mastra/core/workflows";
import { z } from "zod";

import { ConfigDirectory } from "../../common/config/index.js";
import { GitRepository } from "../../common/git/index.js";
import { OpenRouterChat } from "../../common/model/openrouter.js";
import { collectionsRoot } from "../../collections/paths.js";
import { DEFAULT_CHECK_MODEL } from "../../content/intelligibility.js";
import { fetchCommittedItems, type FetchContentOptions } from "../../content/raw-content.js";
import { PollSubstackFeedsOutput } from "./poll-substack-feeds.js";

/**
 * The Substack content fetcher step (#953): the second step of Poll Substack
 * Feeds. Its input is the poller's output; for each new or changed committed
 * feed item it fetches the post and commits the item's raw-content folder.
 *
 * The transcript check uses the canonical mounted OpenRouter key
 * (STEELE_EXP_MASTRA_MODEL_KEY_FILE) through the shared model boundary and a
 * configurable model (STEELE_TRANSCRIPT_CHECK_MODEL, default
 * deepseek/deepseek-v4.1-flash, verified on OpenRouter 2026-11-28).
 */

const FetchSummary = z.object({
  sourceId: z.string(),
  itemId: z.string(),
  status: z.enum(["captured", "unchanged", "failed", "superseded"]),
  error: z.string().optional(),
  path: z.string().optional(),
  commit: z.string().optional(),
  analysis: z.object({ use: z.enum(["article", "transcript", "skip"]), reason: z.string().optional() }).optional(),
  transcript: z.enum(["usable", "unusable", "missing", "fetch-failed", "check-failed"]).optional(),
  images: z.number().optional(),
  thumbnail: z.boolean().optional(),
  retried: z.boolean().optional(),
  pending: z.object({ attempts: z.number(), exhausted: z.boolean() }).optional(),
});

export const FetchSubstackContentOutput = z.object({
  poll: PollSubstackFeedsOutput,
  fetched: z.array(FetchSummary),
});

export function fetchOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FetchContentOptions {
  const root = collectionsRoot(env);
  if (!root) throw new Error("set STEELE_APP_DIR or STEELE_COLLECTIONS_ROOT");
  return {
    config: ConfigDirectory.fromEnv(env),
    repo: new GitRepository(root),
    model: new OpenRouterChat(env.STEELE_EXP_MASTRA_MODEL_KEY_FILE ?? "/run/model/key.toml"),
    modelId: env.STEELE_TRANSCRIPT_CHECK_MODEL || DEFAULT_CHECK_MODEL,
  };
}

export function createFetchSubstackContentStep(options: () => FetchContentOptions = () => fetchOptionsFromEnv()) {
  return createStep({
    id: "fetch-substack-content",
    description: "Fetch each newly committed feed item and commit its raw-content folder (article.json, images, originals).",
    inputSchema: PollSubstackFeedsOutput,
    outputSchema: FetchSubstackContentOutput,
    execute: async ({ inputData }) => {
      // Runs even when the poll committed nothing: earlier incomplete captures are retried.
      const fetched = await fetchCommittedItems(inputData.committed, options());
      return { poll: inputData, fetched };
    },
  });
}

export const fetchSubstackContentStep = createFetchSubstackContentStep();
