import { randomUUID } from "node:crypto";
import { CloudEvent } from "cloudevents";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { DeliveredMessage } from "../controllers/nats.js";
import {
  OperationStoreError,
  type OperationClaim,
  type OperationStore,
  type PendingEventInput,
  type PublicationReceipt,
} from "../controllers/operation-store.js";
import { parsePublishRequest, verifyApprovedArtifact, type PublishRequest } from "./approval.js";
import { DestinationError, type PublicationDestination } from "./destination.js";
import { reconcileUncertainPublication } from "./reconcile.js";

/**
 * Verified publication consumer (#69): a thin worker that wires together the
 * approval gate (#66), publication state (#67), destination adapter (#45)
 * and reconciliation (#68). It holds no state transitions of its own.
 *
 * Sequence, per approved-artifact event:
 * 1. Validate the trusted approval message (shape and provenance only).
 * 2. Respect the pause switch and the frequency limit before any claim.
 * 3. Check publication state: already published returns its receipt, an
 *    uncertain outcome is reconciled by read-back, a running one defers.
 * 4. Claim the publication, then load and check the exact approved artifact.
 * 5. Record intent, reuse or create the destination draft, publish, and
 *    record the receipt with a `published` handoff, then acknowledge.
 *
 * A lost publish response is recorded as uncertain and settled by
 * read-back on the next delivery, so repeated delivery never creates a
 * second draft or publication. Backfill stays disabled unless enabled.
 */

export const ARTICLE_PUBLISHED_SUBJECT = "steele.v1.article.published";
export const ARTICLE_PUBLISHED_EVENT_TYPE_V1 = "org.steele.article.published.v1";

export type PublisherOutcome =
  | { kind: "published"; receipt: PublicationReceipt }
  | { kind: "already-published"; receipt: PublicationReceipt }
  | { kind: "deferred"; reason: "paused" | "rate-limited" | "busy" | "uncertain" | "retry" }
  | { kind: "rejected"; reason: string }
  | { kind: "failed"; reason: string };

export interface PublisherWorkerConfig {
  artifacts: Pick<GitArtifactStore, "read">;
  operations: OperationStore;
  destination: PublicationDestination;
  /** Logical destination name used in publication keys. */
  destinationName: string;
  owner: string;
  /** Pause switch: while true, nothing is claimed or published. */
  paused?: () => boolean;
  /** Minimum time between publications to this destination. */
  minIntervalMs?: number;
  allowBackfill?: boolean;
  /** Title for the destination post; defaults to a neutral response title. */
  titleFor?: (request: PublishRequest, markdown: string) => string;
  retryDelayMs?: number;
  leaseMs?: number;
  now?: () => Date;
}

export class PublisherWorker {
  constructor(private readonly config: PublisherWorkerConfig) {}

  async handle(message: DeliveredMessage, signal?: AbortSignal): Promise<PublisherOutcome> {
    const { operations } = this.config;
    const retryDelay = this.config.retryDelayMs ?? 60_000;

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(message.data));
    } catch {
      message.term();
      return { kind: "rejected", reason: "malformed-event" };
    }
    const parsed = parsePublishRequest(body, {
      destination: this.config.destinationName,
      ...(this.config.allowBackfill ? { allowBackfill: true } : {}),
    });
    if (!parsed.ok) {
      if (parsed.reason === "malformed-event") message.term();
      else await message.ack(); // not an approval, or backfill: nothing to publish
      return { kind: "rejected", reason: parsed.reason };
    }
    const request = parsed.request;

    if (this.config.paused?.()) {
      message.nak(retryDelay);
      return { kind: "deferred", reason: "paused" };
    }

    // Publication state first: published, uncertain or running.
    const state = operations.publicationState(request.key);
    if (state?.status === "published" && state.receipt) {
      await message.ack();
      return { kind: "already-published", receipt: state.receipt };
    }
    if (state?.status === "uncertain") {
      const reconciled = await reconcileUncertainPublication({
        operations,
        destination: this.config.destination,
        key: request.key,
        owner: this.config.owner,
        eventsFor: (receipt) => [this.publishedEvent(request, receipt)],
        ...(signal ? { signal } : {}),
      });
      if (reconciled.status === "published" || reconciled.status === "already-published") {
        await message.ack();
        return { kind: "published", receipt: reconciled.receipt };
      }
      if (reconciled.status === "unpublished") {
        return this.publish(message, request, reconciled.claim, reconciled.draftId, signal);
      }
      message.nak(retryDelay);
      return { kind: "deferred", reason: "uncertain" };
    }

    const wait = this.rateLimitWait();
    if (wait > 0) {
      message.nak(wait);
      return { kind: "deferred", reason: "rate-limited" };
    }

    const claimed = operations.claim(
      request.key,
      this.config.owner,
      this.config.leaseMs ?? 10 * 60_000,
      10,
    );
    if (claimed.kind === "busy") {
      message.nak(Math.max(1_000, claimed.leaseExpiresAt - Date.now()));
      return { kind: "deferred", reason: "busy" };
    }
    if (claimed.kind === "completed") {
      const receipt = operations.publicationState(request.key)?.receipt;
      await message.ack();
      return receipt
        ? { kind: "already-published", receipt }
        : { kind: "failed", reason: "missing-receipt" };
    }
    if (claimed.kind === "exhausted") {
      await message.ack();
      return { kind: "failed", reason: claimed.errorCode ?? "exhausted" };
    }
    return this.publish(message, request, claimed.claim, undefined, signal);
  }

  private async publish(
    message: DeliveredMessage,
    request: PublishRequest,
    claim: OperationClaim,
    knownDraftId: string | undefined,
    signal?: AbortSignal,
  ): Promise<PublisherOutcome> {
    const { operations, destination } = this.config;
    const retryDelay = this.config.retryDelayMs ?? 60_000;
    // Only now load the exact committed article and check its approval.
    const checked = await verifyApprovedArtifact(request, this.config.artifacts);
    if (!checked.ok) {
      operations.fail(claim, `publish:${checked.reason}`, checked.retryable);
      if (checked.retryable) {
        message.nak(retryDelay);
        return { kind: "deferred", reason: "retry" };
      }
      await message.ack();
      return { kind: "rejected", reason: checked.reason };
    }
    let draftId: string | undefined = knownDraftId;
    try {
      const state = operations.recordPublicationIntent(claim, {
        hash: request.draft.hash,
        ref: request.draft,
      });
      draftId ??= state.destinationDraftId;
      if (!draftId) {
        const sourceUrl = checked.markdown.match(/^Original post: (https:\/\/\S+)$/m)?.[1];
        if (!sourceUrl) {
          operations.fail(claim, "publish:missing-source-link", false);
          await message.ack();
          return { kind: "rejected", reason: "missing-source-link" };
        }
        const created = await destination.createDraft(
          {
            title:
              this.config.titleFor?.(request, checked.markdown) ?? `A response to ${sourceUrl}`,
            bodyMarkdown: checked.markdown,
            sourceUrl,
          },
          signal,
        );
        draftId = created.draftId;
        operations.saveDestinationDraft(claim, draftId);
      }
      const published = await destination.publish(draftId, {
        sendEmail: false,
        ...(signal ? { signal } : {}),
      });
      const receipt: PublicationReceipt = {
        url: published.url,
        publishedAt: published.publishedAt,
        destinationPostId: published.draftId,
      };
      operations.confirmPublished(claim, receipt);
      operations.complete(claim, receipt, [this.publishedEvent(request, receipt)]);
      await message.ack();
      return { kind: "published", receipt };
    } catch (error) {
      if (error instanceof DestinationError && error.category === "uncertain" && !draftId) {
        // Creation has no idempotency key: a draft may or may not exist, and
        // it cannot be read back by ID. An operator resolves it; no blind retry.
        operations.fail(claim, "publish:uncertain-creation", false);
        await message.ack();
        return { kind: "failed", reason: "uncertain-creation" };
      }
      if (error instanceof DestinationError && error.category === "uncertain") {
        // The side effect may have happened: never retry blindly; read back.
        operations.markPublicationUncertain(claim);
        operations.fail(claim, "publish:uncertain", true);
        message.nak(Math.min(retryDelay, 30_000));
        return { kind: "deferred", reason: "uncertain" };
      }
      if (error instanceof OperationStoreError) {
        operations.fail(claim, `publish:${error.code}`, false);
        await message.ack();
        return { kind: "failed", reason: error.code };
      }
      const retryable = error instanceof DestinationError ? error.retryable : true;
      const reason = error instanceof DestinationError ? error.category : "publish-error";
      operations.fail(claim, `publish:${reason}`, retryable);
      if (retryable) {
        message.nak(retryDelay);
        return { kind: "deferred", reason: "retry" };
      }
      await message.ack();
      return { kind: "failed", reason };
    }
  }

  /** Time until the frequency limit allows another publication, from durable receipts. */
  private rateLimitWait(): number {
    const min = this.config.minIntervalMs ?? 0;
    if (min <= 0) return 0;
    let latest = 0;
    let after: string | undefined;
    for (;;) {
      const page = this.config.operations.listOperations(
        `publish:${this.config.destinationName}:`,
        200,
        after,
      );
      if (page.length === 0) break;
      for (const op of page) {
        const at = Date.parse(
          (op.artifact as { publishedAt?: string } | undefined)?.publishedAt ?? "",
        );
        if (op.status === "completed" && at > latest) latest = at;
      }
      after = page[page.length - 1]!.key;
    }
    const now = (this.config.now ?? (() => new Date()))().getTime();
    return latest ? Math.max(0, latest + min - now) : 0;
  }

  private publishedEvent(request: PublishRequest, receipt: PublicationReceipt): PendingEventInput {
    const event = new CloudEvent({
      specversion: "1.0",
      id: randomUUID(),
      source: "urn:steele:publishing:worker",
      type: ARTICLE_PUBLISHED_EVENT_TYPE_V1,
      time: new Date().toISOString(),
      subject: `substack/${request.publicationId}/${request.postId}`,
      datacontenttype: "application/json",
      causationid: request.approvalEventId,
      data: {
        publicationId: request.publicationId,
        postId: request.postId,
        destination: request.destination,
        draft: request.draft,
        url: receipt.url,
        publishedAt: receipt.publishedAt,
        ...(receipt.destinationPostId ? { destinationPostId: receipt.destinationPostId } : {}),
      },
    });
    return {
      eventId: event.id,
      subject: ARTICLE_PUBLISHED_SUBJECT,
      payload: JSON.stringify(event.toJSON()),
    };
  }
}
