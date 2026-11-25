import * as clients from "@restatedev/restate-sdk-clients";
import type { DiscoveryPollObject, PollOutcome } from "../discovery/restate-poll.js";

/**
 * Restate client for the DiscoveryPoll job (#823, #824): the one place that
 * knows the object and handler names and the transport options. Callers poll
 * a source by its key and get the job's own outcome.
 */
export function discoveryPollClient(
  ingressUrl: string,
  options: { timeoutMs?: number } = {},
): { pollNow(sourceId: string): Promise<PollOutcome> } {
  const ingress = clients.connect({ url: ingressUrl });
  return {
    async pollNow(sourceId) {
      return ingress
        .objectClient<DiscoveryPollObject>({ name: "DiscoveryPoll" }, sourceId)
        .poll(
          { reason: "manual" },
          clients.rpc.opts({ signal: AbortSignal.timeout(options.timeoutMs ?? 60_000) }),
        );
    },
  };
}
