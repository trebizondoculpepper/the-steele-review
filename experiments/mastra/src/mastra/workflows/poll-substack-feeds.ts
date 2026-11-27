import { createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { PollSubstackFeedsOutput, pollSubstackFeedsStep } from "../steps/poll-substack-feeds.js";

/**
 * Poll Substack Feeds (#944): the first workflow of the reset pilot.
 *
 * Its graph is exactly one step, the Substack poller (#943). It is triggered
 * manually (no schedule) and returns the poller's per-source summary and the
 * references of the records it committed to the feeds collection. Capture,
 * publishing, messaging and scheduling are deliberately outside it.
 */
export const pollSubstackFeedsWorkflow = createWorkflow({
  id: "Poll Substack Feeds",
  description:
    "Poll Substack Feeds: read the enabled Substack sources, poll each RSS feed and commit new or changed discovery records to the feeds collection. Manually triggered; RSS only.",
  inputSchema: z.object({}),
  outputSchema: PollSubstackFeedsOutput,
})
  .then(pollSubstackFeedsStep)
  .commit();
