import { createStep } from "@mastra/core/workflows";
import { z } from "zod";

import { ConfigDirectory } from "../../common/config/index.js";
import { GitRepository } from "../../common/git/index.js";
import { collectionsRoot } from "../../collections/paths.js";
import { pollSubstackFeeds, type PollerOptions } from "../../feed/substack-poller.js";

/**
 * The reusable "poll Substack feeds" step (#943).
 *
 * Reads the source configuration (STEELE_CONFIG_PATH), polls every enabled
 * Substack feed and commits new or changed discovery records to the `feeds`
 * collection of the collections repository (STEELE_COLLECTIONS_ROOT, or
 * `<STEELE_APP_DIR>/collections`). It returns a per-source summary and the
 * committed references. It does no capture, indexing, messaging or publishing;
 * registering it as a workflow is #944.
 */

const SourceSummary = z.object({
  sourceId: z.string(),
  status: z.enum(["ok", "failed"]),
  error: z.string().optional(),
  items: z.number(),
  new: z.number(),
  changed: z.number(),
  unchanged: z.number(),
});

const CommittedRecord = z.object({
  sourceId: z.string(),
  itemId: z.string(),
  path: z.string(),
  change: z.enum(["new", "changed"]),
  commit: z.string(),
});

export const PollSubstackFeedsOutput = z.object({
  ok: z.boolean(),
  commit: z.string().nullable(),
  sources: z.array(SourceSummary),
  committed: z.array(CommittedRecord),
});

/** Dependencies from the environment the private deployment supplies. */
export function pollerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): PollerOptions {
  const root = collectionsRoot(env);
  if (!root) throw new Error("set STEELE_APP_DIR or STEELE_COLLECTIONS_ROOT");
  return { config: ConfigDirectory.fromEnv(env), repo: new GitRepository(root) };
}

export function createPollSubstackFeedsStep(options: () => PollerOptions = () => pollerOptionsFromEnv()) {
  return createStep({
    id: "poll-substack-feeds",
    description: "Poll every enabled Substack feed and commit new or changed discovery records to the feeds collection.",
    inputSchema: z.object({}),
    outputSchema: PollSubstackFeedsOutput,
    // Options are built per run, so configuration changes apply without a restart.
    execute: async () => pollSubstackFeeds(options()),
  });
}

export const pollSubstackFeedsStep = createPollSubstackFeedsStep();
