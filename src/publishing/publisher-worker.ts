import { createHash, randomUUID } from "node:crypto";
import { CloudEvent } from "cloudevents";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { DeliveredMessage } from "../controllers/nats.js";
import {
  OperationStoreError,
  type OperationClaim,
  type OperationStore,
  type PendingEventInput,
  type PublicationReceipt,
} from "../controllers/operation-store.js";
import { parsePublishRequest, verifyApprovedArtifact, type PublishRequest } from "./approval.js";
import {
  DestinationError,
  DraftContentSchema,
  type PublicationDestination,
} from "./destination.js";
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

const refOf = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

export const ARTICLE_PUBLISHED_SUBJECT = "steele.v1.article.published";
export const ARTICLE_PUBLISHED_EVENT_TYPE_V1 = "org.steele.article.published.v1";

export type PublisherOutcome =
  | { kind: "published"; receipt: PublicationReceipt }
  | { kind: "already-published"; receipt: PublicationReceipt }
  | { kind: "deferred"; reason: "paused" | "rate-limited" | "busy" | "uncertain" | "retry" }
  | { kind: "rejected"; reason: string }
  | { kind: "failed"; reason: string };

export interface PublisherWorkerConfig {
  artifacts: Pick<GitArtifactStore, "read" | "write" | "lookup">;
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
      // A crash between confirmation and completion leaves the handoff
      // unrecorded: record it now, before acknowledging.
      let artifact: ArtifactRef;
      try {
        artifact = await this.receiptArtifact(request, state.receipt);
      } catch {
        message.nak(Math.min(retryDelay, 30_000));
        return { kind: "deferred", reason: "retry" };
      }
      if (operations.operationStatus(request.key)?.status !== "completed") {
        try {
          operations.reconcileCompleted(
            request.key,
            { ...state.receipt, artifact: refOf(artifact) },
            [this.publishedEvent(request, state.receipt, artifact)],
          );
        } catch (error) {
          // The confirming worker still holds its lease: come back later.
          if (error instanceof OperationStoreError && error.code === "busy") {
            message.nak(Math.min(this.config.retryDelayMs ?? 60_000, 30_000));
            return { kind: "deferred", reason: "busy" };
          }
          throw error;
        }
      }
      await message.ack();
      return { kind: "already-published", receipt: state.receipt };
    }
    // One admission at a time per destination, so concurrent workers cannot
    // both pass the frequency limit; released on every exit.
    const admission = operations.claim(
      `publish-admission:${this.config.destinationName}`,
      this.config.owner,
      this.config.leaseMs ?? 10 * 60_000,
      1_000,
    );
    if (admission.kind !== "claimed") {
      message.nak(Math.min(retryDelay, 5_000));
      return { kind: "deferred", reason: "busy" };
    }
    // Keep the admission while the publication is in flight, however long
    // artifact loading or destination calls take.
    const lease = this.config.leaseMs ?? 10 * 60_000;
    const renewal = setInterval(
      () => {
        try {
          operations.renew(admission.claim, lease);
        } catch {
          clearInterval(renewal);
        }
      },
      Math.max(1, Math.floor(lease / 3)),
    );
    renewal.unref?.();
    try {
      return await this.admitted(message, request, state?.status, signal);
    } finally {
      clearInterval(renewal);
      try {
        operations.yieldClaim(admission.claim);
      } catch {
        // Lease already lapsed and taken over: nothing to release.
      }
    }
  }

  private async admitted(
    message: DeliveredMessage,
    request: PublishRequest,
    status: string | undefined,
    signal?: AbortSignal,
  ): Promise<PublisherOutcome> {
    const { operations } = this.config;
    const retryDelay = this.config.retryDelayMs ?? 60_000;
    if (status === "uncertain") {
      const reconciled = await reconcileUncertainPublication({
        operations,
        destination: this.config.destination,
        key: request.key,
        owner: this.config.owner,
        eventsFor: (receipt) => [this.publishedEvent(request, receipt)],
        ...(signal ? { signal } : {}),
      });
      if (reconciled.status === "published" || reconciled.status === "already-published") {
        try {
          await this.receiptArtifact(request, reconciled.receipt);
        } catch {
          // Confirmed in state; the next delivery records the receipt artifact.
          message.nak(Math.min(retryDelay, 30_000));
          return { kind: "deferred", reason: "retry" };
        }
        await message.ack();
        return { kind: "published", receipt: reconciled.receipt };
      }
      if (reconciled.status === "unpublished") {
        // Read-back showed nothing was published: republishing is a new
        // publication and must respect the frequency limit too.
        const wait = this.rateLimitWait(request.key);
        if (wait > 0) {
          operations.yieldClaim(reconciled.claim);
          message.nak(wait);
          return { kind: "deferred", reason: "rate-limited" };
        }
        return this.publish(message, request, reconciled.claim, reconciled.draftId, signal);
      }
      message.nak(retryDelay);
      return { kind: "deferred", reason: "uncertain" };
    }

    const wait = this.rateLimitWait(request.key);
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
    let creating = false;
    try {
      const state = operations.recordPublicationIntent(claim, {
        hash: request.draft.hash,
        ref: request.draft,
      });
      if (!draftId && state.destinationDraftId) {
        draftId = state.destinationDraftId;
        // An earlier attempt may have published before stopping: read the
        // saved draft back instead of publishing it again blindly.
        const status = await destination.getStatus(draftId, signal);
        if (status.state === "published") {
          return this.confirm(message, request, claim, {
            url: status.url,
            publishedAt: status.publishedAt,
            destinationPostId: status.draftId,
          });
        }
        if (status.state === "not-found") {
          operations.fail(claim, "publish:draft-missing", false);
          await message.ack();
          return { kind: "failed", reason: "draft-missing" };
        }
      }
      if (!draftId && this.creationMayHaveHappened(request.key)) {
        // An earlier attempt started creating a draft and its outcome was
        // never recorded: a draft may exist that cannot be found by ID.
        operations.fail(claim, "publish:uncertain-creation", false);
        await message.ack();
        return { kind: "failed", reason: "uncertain-creation" };
      }
      if (!draftId) {
        const sourceUrl = checked.markdown.match(/^Original post: (https:\/\/\S+)$/m)?.[1];
        if (!sourceUrl) {
          operations.fail(claim, "publish:missing-source-link", false);
          await message.ack();
          return { kind: "rejected", reason: "missing-source-link" };
        }
        // Validate the content before any marker or side effect.
        const defaultTitle = `A response to ${sourceUrl}`;
        const content = DraftContentSchema.safeParse({
          title:
            this.config.titleFor?.(request, checked.markdown) ??
            (defaultTitle.length <= 280 ? defaultTitle : "A response to a monitored post"),
          bodyMarkdown: checked.markdown,
          sourceUrl,
        });
        if (!content.success) {
          operations.fail(claim, "publish:invalid-content", false);
          await message.ack();
          return { kind: "rejected", reason: "invalid-content" };
        }
        // Durable marker before the side effect, so a restart knows creation
        // may have happened.
        operations.reconcileCompleted(
          `publish-create:${request.key}:${claim.attempt}`,
          { started: true },
          [],
        );
        creating = true;
        const created = await destination.createDraft(content.data, signal);
        draftId = created.draftId;
        operations.saveDestinationDraft(claim, draftId);
        creating = false;
      }
      const published = await destination.publish(draftId, {
        sendEmail: false,
        ...(signal ? { signal } : {}),
      });
      return await this.confirm(message, request, claim, {
        url: published.url,
        publishedAt: published.publishedAt,
        destinationPostId: published.draftId,
      });
    } catch (error) {
      // A creation that definitely did not happen clears its marker's meaning.
      if (creating && error instanceof DestinationError && error.category !== "uncertain") {
        operations.reconcileCompleted(
          `publish-create-none:${request.key}:${claim.attempt}`,
          {},
          [],
        );
      }
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

  private async confirm(
    message: DeliveredMessage,
    request: PublishRequest,
    claim: OperationClaim,
    receipt: PublicationReceipt,
  ): Promise<PublisherOutcome> {
    this.config.operations.confirmPublished(claim, receipt);
    let artifact: ArtifactRef;
    try {
      artifact = await this.receiptArtifact(request, receipt);
    } catch {
      // Publication is confirmed in state; the next delivery records the receipt.
      this.config.operations.fail(claim, "publish:receipt-commit-failed", true);
      message.nak(Math.min(this.config.retryDelayMs ?? 60_000, 30_000));
      return { kind: "deferred", reason: "retry" };
    }
    this.config.operations.complete(claim, { ...receipt, artifact: refOf(artifact) }, [
      this.publishedEvent(request, receipt, artifact),
    ]);
    await message.ack();
    return { kind: "published", receipt };
  }

  /**
   * The versioned receipt record for a publication, written once per
   * publication key and reused thereafter (idempotent across retries).
   */
  private async receiptArtifact(
    request: PublishRequest,
    receipt: PublicationReceipt,
  ): Promise<ArtifactRef> {
    const path = `publications/${request.publicationId}/${request.postId}/${createHash("sha256").update(request.key).digest("hex")}.json`;
    const existing = await this.config.artifacts.lookup(path);
    if (existing) return existing;
    const record = {
      schemaVersion: 1,
      destination: request.destination,
      publicationId: request.publicationId,
      postId: request.postId,
      ingestionReason: request.ingestionReason,
      draft: request.draft,
      report: request.report,
      receipt,
    };
    return this.config.artifacts.write(path, `${JSON.stringify(record, null, 2)}\n`);
  }

  /** True when an earlier attempt began creating a draft with no recorded outcome. */
  private creationMayHaveHappened(key: string): boolean {
    const { operations } = this.config;
    for (const marker of operations.listOperations(`publish-create:${key}:`, 1_000)) {
      const attempt = marker.key.slice(`publish-create:${key}:`.length);
      if (
        operations.operationStatus(`publish-create-none:${key}:${attempt}`)?.status !== "completed"
      )
        return true;
    }
    return false;
  }

  /** Time until the frequency limit allows another publication, from durable receipts. */
  private rateLimitWait(exceptKey?: string): number {
    const min = this.config.minIntervalMs ?? 0;
    if (min <= 0) return 0;
    let unsettled = false;
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
        // Receipts live in the publication state, whichever path confirmed them.
        const pub = this.config.operations.publicationState(op.key);
        const at = Date.parse(pub?.receipt?.publishedAt ?? "");
        if (at > latest) latest = at;
        // Another article's uncertain outcome may already be a publication
        // whose time is unknown: admit nothing new until read-back settles it.
        if (pub?.status === "uncertain" && op.key !== exceptKey) unsettled = true;
        // So may an interrupted attempt that saved a draft, or a draft read
        // back as unpublished that is being republished, and may have
        // published before stopping (not a settled or permanent failure).
        if (
          (pub?.status === "draft-saved" || pub?.status === "unpublished") &&
          op.key !== exceptKey &&
          op.status !== "completed" &&
          !op.exhausted
        ) {
          unsettled = true;
        }
      }
      after = page[page.length - 1]!.key;
    }
    if (unsettled) return Math.max(1_000, Math.min(min, this.config.retryDelayMs ?? 60_000));
    const now = (this.config.now ?? (() => new Date()))().getTime();
    return latest ? Math.max(0, latest + min - now) : 0;
  }

  private publishedEvent(
    request: PublishRequest,
    receipt: PublicationReceipt,
    artifact?: ArtifactRef,
  ): PendingEventInput {
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
        ...(artifact ? { receiptArtifact: refOf(artifact) } : {}),
      },
    });
    return {
      eventId: event.id,
      subject: ARTICLE_PUBLISHED_SUBJECT,
      payload: JSON.stringify(event.toJSON()),
    };
  }
}
