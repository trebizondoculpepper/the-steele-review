import { createHash } from "node:crypto";
import type { SubstackItem } from "../content/substack-item.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { DEFAULT_DISCOVERY_SUBJECT } from "../controllers/nats-discovery.js";
import { createDiscoveryEvent, serializeDiscoveryEvent } from "../events/discovery-event.js";
import { reingestKey } from "./collection-store.js";

/**
 * Request a deliberate single-item reingestion (#558).
 *
 * Records a new `reingest:` operation and its discovery event in one state
 * transaction; the running collector publishes the event and performs the
 * work: fresh fetch, reuse of an existing transcript instead of paying again,
 * and an in-place revision of the capture record at its stable path. A
 * repeated request id changes nothing. Ordinary discovery is unaffected.
 */
export const REQUEST_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

export type ReingestRequestOutcome =
  | { outcome: "requested"; key: string; eventId: string }
  | { outcome: "already-requested"; key: string; status: string }
  | { outcome: "conflicting-request"; key: string; open: string };

export function reingestEventId(
  item: Pick<SubstackItem, "publicationId" | "postId">,
  requestId: string,
) {
  const digest = createHash("sha256")
    .update(JSON.stringify(["reingest", item.publicationId, item.postId, requestId]))
    .digest("hex");
  return `reingest-${digest.slice(0, 32)}`;
}

export function requestReingest(input: {
  operations: OperationStore;
  item: SubstackItem;
  requestId: string;
  subject?: string;
  now?: () => Date;
}): ReingestRequestOutcome {
  if (!REQUEST_ID.test(input.requestId)) throw new Error("invalid request id");
  const key = reingestKey(input.item, input.requestId);
  const eventId = reingestEventId(input.item, input.requestId);
  const event = createDiscoveryEvent(
    input.item,
    { reason: "reprocess", reingestRequestId: input.requestId },
    { newId: () => eventId, now: input.now ?? (() => new Date()) },
  );
  // One reingestion per item at a time: a later request cannot replace the
  // recovery marker of one still in flight.
  const prefix = key.slice(0, key.lastIndexOf("/") + 1);
  const result = input.operations.requestOperation(
    key,
    {
      eventId,
      subject: input.subject ?? DEFAULT_DISCOVERY_SUBJECT,
      payload: serializeDiscoveryEvent(event),
    },
    5,
    prefix,
  );
  if (result.kind === "conflicting-request") {
    return { outcome: "conflicting-request", key, open: result.key };
  }
  return result.kind === "requested"
    ? { outcome: "requested", key, eventId }
    : { outcome: "already-requested", key, status: result.status };
}
