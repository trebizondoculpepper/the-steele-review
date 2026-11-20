import { createHash } from "node:crypto";
import { parseResearchReindexEvent } from "../events/research-reindex-event.js";

/**
 * Handle one delivered research reindex request (#232). Returns what to do
 * with the message, so the caller (the worker's consumer loop) owns
 * acknowledgment:
 * - malformed request or unknown route: `term` (never redelivered, logged);
 * - reconciliation completed: `ack`;
 * - another reconciler holds the lease: `nak` with a short delay, since that
 *   pass may have started before the change this request is about;
 * - reconciliation failed: `nak` with a delay (durable retry), until the
 *   final permitted delivery, which is `term`inated as `retries-exhausted`
 *   so the caller records the failure durably instead of losing it.
 * Duplicate delivery is safe: reconciliation is idempotent from the checkpoint.
 */
export type ReindexDecision =
  | { action: "ack"; route: string; outcome: "reconciled" }
  | {
      action: "term";
      reason: "malformed-request" | "unknown-route" | "retries-exhausted";
      route?: string;
      requestId?: string;
    }
  | { action: "nak"; route: string; delayMs: number; why: "busy" | "failed" };

/** Request identity for failure records: CloudEvents identity is (source, id). */
export const requestKey = (r: { source: string; id: string }) =>
  `req-${createHash("sha256")
    .update(JSON.stringify([r.source, r.id]))
    .digest("hex")
    .slice(0, 40)}`;

export async function handleReindexRequest(
  payload: Uint8Array,
  routes: ReadonlySet<string>,
  /** Run one leased pass for the route: true done, "busy" another holder, false failed. */
  reconcile: (route: string) => Promise<true | false | "busy">,
  retryDelayMs = 30_000,
  busyDelayMs = 5_000,
  delivery: { count: number; max: number } = { count: 1, max: Number.POSITIVE_INFINITY },
): Promise<ReindexDecision> {
  let request;
  try {
    request = parseResearchReindexEvent(new TextDecoder().decode(payload));
  } catch {
    // No trustworthy ID: identify the rejected payload by its hash.
    const requestId = `payload-${createHash("sha256").update(payload).digest("hex").slice(0, 32)}`;
    return { action: "term", reason: "malformed-request", requestId };
  }
  if (!routes.has(request.route)) {
    return {
      action: "term",
      reason: "unknown-route",
      route: request.route,
      requestId: requestKey(request),
    };
  }
  const result = await reconcile(request.route);
  if (result === true) return { action: "ack", route: request.route, outcome: "reconciled" };
  if (delivery.count >= delivery.max) {
    return {
      action: "term",
      reason: "retries-exhausted",
      route: request.route,
      requestId: requestKey(request),
    };
  }
  if (result === "busy")
    return { action: "nak", route: request.route, delayMs: busyDelayMs, why: "busy" };
  return { action: "nak", route: request.route, delayMs: retryDelayMs, why: "failed" };
}
