import { createHash } from "node:crypto";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { NatsController } from "../controllers/nats.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  handleApprovedArticle,
  readDestinationDeliveryProof,
  type DestinationAdapter,
  type DraftDeliveryControl,
} from "./approved-article.js";
import { parseArticleApprovedEvent } from "../events/article-approved-event.js";
import type { ArtifactRef } from "../controllers/artifact-store.js";

export type SelectedPublisherResult =
  | { status: "delivered" | "reused"; receipt: ArtifactRef }
  | {
      status: "stopped";
      reason:
        | "selection-mismatch"
        | "ack-uncertain"
        | "handler-unavailable"
        | "pending"
        | "rejected"
        | "receipt-mismatch"
        | "timeout";
    };

/**
 * The consume loop shared by publisher services (#315 dummy publishers, #385
 * Substack): one destination, its own durable consumer on the publication
 * stream, and the approved-article handler deciding ack, nak or term.
 * Status lines are sanitised JSON via `log`. Stops when `signal` aborts.
 */
export async function runPublisherService(input: {
  nats: Pick<NatsController, "consume">;
  stream: string;
  consumer: string;
  destination: DestinationAdapter;
  content: GitArtifactStore;
  operations: OperationStore;
  deliveryControl?: DraftDeliveryControl;
  owner: string;
  delayMs: number;
  retryDelayMs: number;
  log: (fields: Record<string, unknown>) => void;
  signal: AbortSignal;
  /** Optional explicit one-shot contract; absent preserves continuous processing. */
  selection?: {
    eventId: string;
    sequence: number;
    payload: string;
    requireRealReceipt?: boolean;
    onResult(result: SelectedPublisherResult): void;
  };
}): Promise<void> {
  const { destination, operations, log } = input;
  const stop = new AbortController();
  const signal = input.selection ? AbortSignal.any([input.signal, stop.signal]) : input.signal;
  const settle = (result: SelectedPublisherResult) => {
    input.selection?.onResult(result);
    stop.abort();
  };
  log({ state: "consuming" });
  await input.nats.consume(
    input.stream,
    input.consumer,
    async (m) => {
      const payload = new TextDecoder().decode(m.data);
      if (input.selection) {
        let matches = false;
        try {
          matches =
            m.streamSequence === input.selection.sequence &&
            payload === input.selection.payload &&
            parseArticleApprovedEvent(payload).eventId === input.selection.eventId;
        } catch {
          /* Untrusted selection fails without acknowledging the message. */
        }
        if (!matches) {
          settle({ status: "stopped", reason: "selection-mismatch" });
          return;
        }
      }
      let decision;
      try {
        decision = await handleApprovedArticle({
          payload,
          destination,
          schedule: { delayMs: input.delayMs },
          content: input.content,
          operations,
          ...(input.deliveryControl ? { deliveryControl: input.deliveryControl } : {}),
          owner: input.owner,
          retryDelayMs: input.retryDelayMs,
        });
      } catch (error) {
        if (!input.selection) throw error;
        settle({ status: "stopped", reason: "handler-unavailable" });
        return;
      }
      if (decision.action === "ack") {
        if (input.selection?.requireRealReceipt) {
          try {
            const { eventId: _eventId, ...approved } = parseArticleApprovedEvent(payload);
            if (
              !(await readDestinationDeliveryProof(
                input.content,
                approved,
                destination,
                false,
                input.operations,
              ))
            )
              throw new Error();
          } catch {
            settle({ status: "stopped", reason: "receipt-mismatch" });
            return;
          }
        }
        log({ action: "ack", outcome: decision.outcome, receipt: decision.receipt.path });
        try {
          await m.ack();
        } catch (error) {
          if (!input.selection) throw error;
          settle({ status: "stopped", reason: "ack-uncertain" });
          return;
        }
        if (input.selection) settle({ status: decision.outcome, receipt: decision.receipt });
      } else if (decision.action === "nak") {
        log({ action: "nak", reason: decision.reason });
        m.nak(decision.delayMs);
        if (input.selection) settle({ status: "stopped", reason: "pending" });
      } else {
        // A content digest stays stable across redelivery and identifies even
        // malformed payloads without trusting or retaining their content.
        const digest = createHash("sha256").update(m.data).digest("hex");
        operations.recordPermanentFailure(
          `publisher-rejected:${destination.name}:${digest}`,
          decision.reason,
        );
        log({ action: "term", reason: decision.reason });
        m.term();
        if (input.selection) settle({ status: "stopped", reason: "rejected" });
      }
    },
    signal,
    ...(input.selection ? [{ once: true }] : []),
  );
}
