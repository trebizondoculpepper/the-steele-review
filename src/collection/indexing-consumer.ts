import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { DeliveredMessage } from "../controllers/nats.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { parseTextReadyEvent } from "../events/text-ready-event.js";
import {
  handleTextReadyEvent,
  type FulltextIndexPort,
  type IndexingOutcome,
} from "./indexing-handler.js";

/**
 * Indexing consumer: turns delivered text-ready messages into acknowledgment
 * decisions around the one-event handler (#94). It owns acknowledgment and
 * nothing else: projection and index writes stay in the handler and its
 * controllers.
 *
 * - `indexed` and `stale` (already indexed or older) → acknowledge.
 * - `retry` (index timeout/outage, transient archive read) → redeliver later.
 * - `failed`, `incomplete` and malformed messages → recorded as a visible,
 *   non-retryable outcome through the state controller, then acknowledged
 *   (malformed messages are terminated), so they are neither lost silently
 *   nor redelivered forever.
 *
 * Work is bounded by the consumer delivering one message at a time.
 */

export type IndexingDecision =
  | { action: "ack"; outcome: IndexingOutcome["kind"] }
  | { action: "nak"; reason: string }
  | { action: "term"; reason: "invalid-event" };

export interface IndexingConsumerConfig {
  artifacts: Pick<GitArtifactStore, "read">;
  index: FulltextIndexPort;
  indexName?: string;
  operations: OperationStore;
  owner: string;
  retryDelayMs?: number;
  timeoutMs?: number;
  onDecision?: (decision: IndexingDecision) => void;
}

export class IndexingConsumer {
  constructor(private readonly config: IndexingConsumerConfig) {}

  /** Record a permanent outcome so it stays visible after acknowledgment. */
  private recordPermanent(key: string, reason: string): void {
    const claimed = this.config.operations.claim(key, this.config.owner, 60_000, 1);
    if (claimed.kind === "claimed") this.config.operations.fail(claimed.claim, reason, false);
  }

  async handle(message: DeliveredMessage): Promise<IndexingDecision> {
    const decision = await this.decide(message);
    this.config.onDecision?.(decision);
    return decision;
  }

  private async decide(message: DeliveredMessage): Promise<IndexingDecision> {
    let event;
    try {
      event = parseTextReadyEvent(new TextDecoder().decode(message.data));
    } catch {
      message.term();
      return { action: "term", reason: "invalid-event" };
    }
    const key = `index:${event.subject}:${event.id}`;
    const outcome = await handleTextReadyEvent({
      event,
      artifacts: this.config.artifacts,
      index: this.config.index,
      indexName: this.config.indexName,
      timeoutMs: this.config.timeoutMs,
    });
    switch (outcome.kind) {
      case "indexed":
      case "stale":
        await message.ack();
        return { action: "ack", outcome: outcome.kind };
      case "retry":
        message.nak(this.config.retryDelayMs ?? 30_000);
        return { action: "nak", reason: outcome.reason };
      case "incomplete":
        this.recordPermanent(key, "incomplete-content");
        await message.ack();
        return { action: "ack", outcome: "incomplete" };
      case "failed":
        this.recordPermanent(key, outcome.reason);
        await message.ack();
        return { action: "ack", outcome: "failed" };
    }
  }
}
