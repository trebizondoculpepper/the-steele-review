import { createHash } from "node:crypto";
import { z } from "zod";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import type { NatsController } from "../controllers/nats.js";
import { provisionDurableConsumer } from "../controllers/nats-provision.js";
import {
  ARTICLE_APPROVED_SUBJECT,
  parseArticleApprovedEvent,
} from "../events/article-approved-event.js";
import {
  readApprovedContent,
  readDummyDeliveryProof,
  readDestinationDeliveryProof,
  type DestinationAdapter,
} from "./approved-article.js";
import { runPublisherService, type SelectedPublisherResult } from "./publisher-service.js";

export const SelectedPublisherInputSchema = z
  .object({
    eventId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    waitMs: z.number().int().min(1).max(300_000).default(30_000),
  })
  .strict();
export class SelectedPublisherError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "selection-mismatch"
      | "not-dispatched"
      | "dummy-proof-missing"
      | "ack-without-receipt",
  ) {
    super(`selected publisher: ${code}`);
    this.name = "SelectedPublisherError";
  }
}

/** One real consumer, one retained approved event; never dispatches or enables a loop. */
export async function runSelectedPublisher(input: {
  selection: unknown;
  nats: Pick<NatsController, "readMessage" | "consumerPosition" | "consume" | "manager">;
  stream: string;
  content: GitArtifactStore;
  operations: OperationStore;
  destination: DestinationAdapter;
  owner: string;
  delayMs?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
}): Promise<SelectedPublisherResult & { consumer: string }> {
  const parsed = SelectedPublisherInputSchema.safeParse(input.selection);
  if (!parsed.success) throw new SelectedPublisherError("invalid-input");
  const selection = parsed.data;
  const pending = input.operations.pendingEvent(selection.eventId);
  if (!pending || input.operations.pendingEventStatus(selection.eventId) !== "sent")
    throw new SelectedPublisherError("not-dispatched");
  let article;
  try {
    article = parseArticleApprovedEvent(pending.payload);
  } catch {
    throw new SelectedPublisherError("selection-mismatch");
  }
  const message = await input.nats.readMessage(input.stream, selection.sequence);
  if (
    pending.subject !== ARTICLE_APPROVED_SUBJECT ||
    article.eventId !== selection.eventId ||
    message.subject !== ARTICLE_APPROVED_SUBJECT ||
    message.sequence !== selection.sequence ||
    message.messageId !== selection.eventId ||
    new TextDecoder().decode(message.data) !== pending.payload
  )
    throw new SelectedPublisherError("selection-mismatch");
  await readApprovedContent(input.content, article);
  const { eventId: _eventId, ...approved } = article;
  if (!(await readDummyDeliveryProof(input.content, approved)))
    throw new SelectedPublisherError("dummy-proof-missing");
  const suffix = createHash("sha256")
    .update(
      JSON.stringify([
        "selected-publisher-v1",
        input.stream,
        selection.eventId,
        selection.sequence,
        input.destination.name,
        input.destination.action,
      ]),
    )
    .digest("hex")
    .slice(0, 40);
  const consumer = `selected-${suffix}`;
  await provisionDurableConsumer(input.nats, {
    stream: input.stream,
    name: consumer,
    filterSubject: ARTICLE_APPROVED_SUBJECT,
    startSequence: selection.sequence,
    maxAckPending: 1,
    maxDeliver: 10,
  });
  const position = await input.nats.consumerPosition(input.stream, consumer);
  if (position.ackFloorSequence >= selection.sequence) {
    const receipt = await readDestinationDeliveryProof(
      input.content,
      approved,
      input.destination,
      false,
    );
    if (!receipt || position.ackFloorSequence !== selection.sequence)
      throw new SelectedPublisherError("ack-without-receipt");
    return { status: "reused", receipt, consumer };
  }
  const timeout = AbortSignal.timeout(selection.waitMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  let result: SelectedPublisherResult | undefined;
  await runPublisherService({
    ...input,
    consumer,
    delayMs: input.delayMs ?? 0,
    retryDelayMs: input.retryDelayMs ?? 30_000,
    signal,
    log: () => {},
    selection: {
      ...selection,
      payload: pending.payload,
      requireRealReceipt: true,
      onResult: (value) => {
        result = value;
      },
    },
  });
  return { ...(result ?? { status: "stopped" as const, reason: "timeout" as const }), consumer };
}
