import {
  OperationStoreError,
  type OperationClaim,
  type OperationStore,
  type PendingEventInput,
  type PublicationReceipt,
} from "../controllers/operation-store.js";
import {
  reconcilePublication,
  type PublicationDestination,
  type PublishedReceipt,
} from "./destination.js";

/**
 * Reconcile an uncertain publication by reading back its stored destination
 * draft. This is a small exceptional path inside publishing, not a service:
 *
 * - It needs the destination draft ID saved before publishing (#67). Without
 *   one there is nothing safe to read back; that is reported, never worked
 *   around by creating a fresh draft.
 * - It never creates or publishes anything. A read-back showing the draft is
 *   still unpublished is recorded and the claim handed back, because
 *   republishing that same draft is then safe; the caller (the publisher)
 *   decides whether to do so.
 * - Read-back failures are retried a bounded number of times; afterwards the
 *   outcome stays uncertain and the claim is released for a later attempt.
 * - A missing draft or a receipt that conflicts with a stored one is left
 *   uncertain for an operator rather than resolved automatically.
 * - Every transition goes through the private state controller with the
 *   reconciliation claim as its fencing token.
 */

export type ReconcileOutcome =
  | { status: "published"; receipt: PublicationReceipt }
  | { status: "already-published"; receipt: PublicationReceipt }
  | { status: "unpublished"; claim: OperationClaim; draftId: string }
  | { status: "still-uncertain" }
  | { status: "draft-missing" }
  | { status: "conflict" }
  | { status: "busy" }
  | {
      status: "not-reconcilable";
      reason: "no-publication" | "no-destination-draft" | "not-uncertain";
    }
  | { status: "cancelled" };

export interface ReconcileOptions {
  operations: OperationStore;
  destination: PublicationDestination;
  /** Publication operation key. */
  key: string;
  owner: string;
  leaseMs?: number;
  /** Read-back attempts before leaving the outcome uncertain. */
  maxReadAttempts?: number;
  retryDelayMs?: number;
  /** Events to hand off atomically when publication is confirmed. */
  eventsFor?: (receipt: PublicationReceipt) => PendingEventInput[];
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const toReceipt = (r: PublishedReceipt): PublicationReceipt => ({
  url: r.url,
  publishedAt: r.publishedAt,
  destinationPostId: r.draftId,
});

export async function reconcileUncertainPublication(
  options: ReconcileOptions,
): Promise<ReconcileOutcome> {
  const { operations, destination, key, signal } = options;
  const state = operations.publicationState(key);
  if (!state) return { status: "not-reconcilable", reason: "no-publication" };
  if (state.status === "published" && state.receipt) {
    return { status: "already-published", receipt: state.receipt };
  }
  if (!state.destinationDraftId) {
    return { status: "not-reconcilable", reason: "no-destination-draft" };
  }
  if (state.status !== "uncertain" && state.status !== "draft-saved") {
    return { status: "not-reconcilable", reason: "not-uncertain" };
  }
  if (signal?.aborted) return { status: "cancelled" };

  const claimed = operations.claimForReconciliation(
    key,
    options.owner,
    options.leaseMs ?? 10 * 60_000,
  );
  if (claimed.kind === "busy") return { status: "busy" };
  if (claimed.kind !== "claimed") {
    const latest = operations.publicationState(key);
    return latest?.receipt
      ? { status: "already-published", receipt: latest.receipt }
      : { status: "still-uncertain" };
  }
  const claim = claimed.claim;
  const draftId = state.destinationDraftId;
  const attempts = Math.max(1, Math.min(options.maxReadAttempts ?? 3, 10));
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      operations.fail(claim, "reconcile-cancelled", true);
      return { status: "cancelled" };
    }
    const result = await reconcilePublication(destination, draftId, signal);
    if (result.outcome === "published") {
      const receipt = toReceipt(result.receipt);
      try {
        operations.confirmPublished(claim, receipt);
      } catch (error) {
        if (error instanceof OperationStoreError && error.code === "destination-conflict") {
          operations.fail(claim, "reconcile-conflict", false);
          return { status: "conflict" };
        }
        throw error;
      }
      operations.complete(claim, { receipt }, options.eventsFor?.(receipt) ?? []);
      return { status: "published", receipt };
    }
    if (result.outcome === "unpublished") {
      operations.markPublicationUnpublished(claim);
      return { status: "unpublished", claim, draftId };
    }
    if (result.outcome === "missing") {
      // The stored draft has gone. Creating a replacement could duplicate a
      // post that was published and then removed: leave it for an operator.
      operations.fail(claim, "reconcile-draft-missing", false);
      return { status: "draft-missing" };
    }
    if (attempt < attempts) await sleep((options.retryDelayMs ?? 5_000) * attempt);
  }
  operations.fail(claim, "reconcile-unavailable", true);
  return { status: "still-uncertain" };
}
