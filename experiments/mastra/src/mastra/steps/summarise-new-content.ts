import { createStep } from "@mastra/core/workflows";
import { z } from "zod";

import { GitRepository } from "../../common/git/index.js";
import { OpenRouterChat } from "../../common/model/openrouter.js";
import { collectionsRoot } from "../../collections/paths.js";
import { DEFAULT_SUMMARY_MODEL, summariseSource, type SummariseOptions } from "../../summaries/summarise.js";
import { FetchSubstackContentOutput } from "./fetch-substack-content.js";

/**
 * Summarise newly retained content (#962): the third step of Poll Substack
 * Feeds. For every item the fetcher captured in this run (a new or changed,
 * durably saved source version), one bounded model call writes a short neutral
 * summary. Each item's outcome is recorded separately: unavailable input or a
 * model failure is reported and the other items continue. Replays reuse the
 * completed summary of the same source version without another model call.
 */

const ItemSummary = z.object({
  sourceId: z.string(),
  itemId: z.string(),
  outcome: z.enum(["proposed", "partial", "none-valid", "skipped", "model-failed", "error"]),
  reused: z.boolean().optional(),
  reason: z.string().optional(),
  summaryId: z.string().optional(),
  path: z.string().optional(),
  usage: z.object({ promptTokens: z.number().nullable(), completionTokens: z.number().nullable(), costUsd: z.number().nullable() }).nullable().optional(),
  totalMs: z.number().optional(),
});

export const SummariseNewContentOutput = FetchSubstackContentOutput.extend({ summaries: z.array(ItemSummary) });

export function summaryOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SummariseOptions {
  const root = collectionsRoot(env);
  if (!root) throw new Error("set STEELE_APP_DIR or STEELE_COLLECTIONS_ROOT");
  return {
    repo: new GitRepository(root),
    model: new OpenRouterChat(env.STEELE_EXP_MASTRA_MODEL_KEY_FILE ?? "/run/model/key.toml"),
    modelId: env.STEELE_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL,
  };
}

export function createSummariseNewContentStep(options: () => SummariseOptions = () => summaryOptionsFromEnv()) {
  return createStep({
    id: "summarise-new-content",
    description: "Write a short neutral summary of each newly captured source version; replays reuse the saved summary.",
    inputSchema: FetchSubstackContentOutput,
    outputSchema: SummariseNewContentOutput,
    execute: async ({ inputData }) => {
      const captured = inputData.fetched.filter((f) => f.status === "captured" && f.path && f.commit);
      const summaries: z.infer<typeof ItemSummary>[] = [];
      const opts = captured.length ? options() : null;
      for (const item of captured) {
        try {
          const r = await summariseSource({ path: item.path!, commit: item.commit! }, opts!);
          summaries.push({
            sourceId: item.sourceId,
            itemId: item.itemId,
            outcome: r.outcome,
            reused: r.reused,
            ...(r.reason ? { reason: r.reason } : {}),
            ...(r.summary ? { summaryId: r.summary.summaryId, path: r.summary.path } : {}),
            usage: r.usage,
            totalMs: r.timings.totalMs,
          });
        } catch {
          // A technical failure for one item is reported; the others continue.
          summaries.push({ sourceId: item.sourceId, itemId: item.itemId, outcome: "error", reason: "summary-failed" });
        }
      }
      return { ...inputData, summaries };
    },
  });
}

export const summariseNewContentStep = createSummariseNewContentStep();
