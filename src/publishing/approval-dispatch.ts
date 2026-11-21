import type { OperationStore } from "../controllers/operation-store.js";
import { ARTICLE_APPROVED_SUBJECT } from "../events/article-approved-event.js";

/**
 * Approval outbox dispatch (#271, for #244).
 *
 * `recordApproval` (#262) writes each approved-article event into the state
 * controller's outbox in the same step as the approval. This publishes the
 * due ones to JetStream with the event ID as the message ID, so a repeated
 * dispatch is deduplicated by the broker, then marks each one sent. A failed
 * publish stays pending with the same ID and is retried after a delay.
 *
 * It is the one path from an approval to the publisher stream: destinations
 * consume `steele.v1.article.approved` from `STEELE_PUBLICATION` and never
 * read the outbox directly.
 */

export interface ApprovalPublisher {
  publish(subject: string, data: Uint8Array, options: { msgId: string }): Promise<unknown>;
}

export async function dispatchApprovedArticles(input: {
  operations: Pick<OperationStore, "duePendingEvents" | "markEventSent" | "markEventRetry">;
  publisher: ApprovalPublisher;
  retryDelayMs?: number;
  limit?: number;
}): Promise<{ sent: number; retrying: number }> {
  let sent = 0;
  let retrying = 0;
  for (const pending of input.operations.duePendingEvents(
    input.limit ?? 200,
    ARTICLE_APPROVED_SUBJECT,
  )) {
    try {
      await input.publisher.publish(pending.subject, new TextEncoder().encode(pending.payload), {
        msgId: pending.eventId,
      });
      input.operations.markEventSent(pending.eventId);
      sent++;
    } catch {
      input.operations.markEventRetry(pending.eventId, input.retryDelayMs ?? 60_000);
      retrying++;
    }
  }
  return { sent, retrying };
}
