import { createHash } from "node:crypto";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { NatsController } from "../controllers/nats.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { handleApprovedArticle, type DestinationAdapter } from "./approved-article.js";

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
  owner: string;
  delayMs: number;
  retryDelayMs: number;
  log: (fields: Record<string, unknown>) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { destination, operations, log } = input;
  log({ state: "consuming" });
  await input.nats.consume(
    input.stream,
    input.consumer,
    async (m) => {
      const decision = await handleApprovedArticle({
        payload: new TextDecoder().decode(m.data),
        destination,
        schedule: { delayMs: input.delayMs },
        content: input.content,
        operations,
        owner: input.owner,
        retryDelayMs: input.retryDelayMs,
      });
      if (decision.action === "ack") {
        log({ action: "ack", outcome: decision.outcome, receipt: decision.receipt.path });
        await m.ack();
      } else if (decision.action === "nak") {
        log({ action: "nak", reason: decision.reason });
        m.nak(decision.delayMs);
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
      }
    },
    input.signal,
  );
}
