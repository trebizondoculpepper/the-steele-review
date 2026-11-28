import { createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { fetchSubstackContentStep } from "../steps/fetch-substack-content.js";
import { SummariseNewContentOutput, summariseNewContentStep } from "../steps/summarise-new-content.js";
import { pollSubstackFeedsStep } from "../steps/poll-substack-feeds.js";

/**
 * Poll Substack Feeds (#944, #953): the first workflow of the reset pilot.
 *
 * Three steps: the Substack poller (#943) commits new or changed feed records,
 * the content fetcher (#953) captures each of those items into the raw-content
 * collection, and each newly captured source version is summarised (#962). Triggered manually (no schedule). It returns the
 * poller's per-source summary and committed references, and a summary per
 * fetched item. Publishing, messaging and scheduling stay outside it.
 */
export const pollSubstackFeedsWorkflow = createWorkflow({
  id: "Poll Substack Feeds",
  description:
    "Poll Substack Feeds: poll each enabled Substack RSS feed, commit new or changed discovery records, then fetch each of those items into the raw-content collection. Manually triggered.",
  inputSchema: z.object({}),
  outputSchema: SummariseNewContentOutput,
})
  .then(pollSubstackFeedsStep)
  .then(fetchSubstackContentStep)
  .then(summariseNewContentStep)
  .commit();
