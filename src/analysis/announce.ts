import { createHash } from "node:crypto";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  POST_ANALYSED_SUBJECT,
  createPostAnalysedEvent,
  type PostAnalysedData,
} from "../events/post-analysed-event.js";
import { readAnalysisPair } from "./analysis-pair.js";

/**
 * Record and (optionally) dispatch one post-analysed completion event (#178).
 *
 * Both saved results are re-read and validated first: they must describe the
 * same post and source version, and the claim result must link to exactly
 * this theme result. Failed, malformed, legacy or mismatched results never
 * produce a completion event. The event is recorded in the state
 * controller's pending-event outbox before any publish, with a stable ID
 * derived from the two result references, so a crash or repeated run yields
 * one logical completion. Publishing is a separate, explicit step.
 */

export interface EventPublisher {
  publish(subject: string, payload: Uint8Array, options: { msgId: string }): Promise<unknown>;
}

export type AnnounceOutcome =
  | {
      status: "recorded";
      eventId: string;
      /** False when this exact completion had already been recorded. */
      newlyRecorded: boolean;
      delivery: "pending" | "sent";
      data: PostAnalysedData;
    }
  | {
      /** Every attempt was interrupted before completion; nothing was recorded. */
      status: "exhausted";
      eventId: string;
    }
  | {
      status: "refused";
      reason:
        | "unreadable-theme-result"
        | "unreadable-claim-result"
        | "legacy-claim-result"
        | "post-mismatch"
        | "source-version-mismatch"
        | "theme-result-not-linked";
    }
  | { status: "busy" };

const short = (r: ArtifactRef) => `${r.commit}:${r.path}`;
const asReference = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

/** Stable event ID for one (theme result, claim result) pair. */
export function postAnalysedEventId(themeRef: ArtifactRef, claimRef: ArtifactRef): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["post-analysed", short(themeRef), short(claimRef)]))
    .digest("hex");
  return `analysed-${digest.slice(0, 32)}`;
}

export async function announcePost(input: {
  content: Pick<GitArtifactStore, "read">;
  operations: OperationStore;
  post: { publicationId: string; postId: string };
  themeRef: ArtifactRef;
  claimRef: ArtifactRef;
  owner: string;
  now?: () => Date;
}): Promise<AnnounceOutcome> {
  const pair = await readAnalysisPair(input.content, input.post, input.themeRef, input.claimRef);
  if (pair.status === "refused") return { status: "refused", reason: pair.reason };
  const { theme, claims } = pair;

  const data: PostAnalysedData = {
    ...input.post,
    sourceVersion: theme.sourceVersion,
    sourceArtifact: theme.artifact,
    themeResult: asReference(input.themeRef),
    claimResult: asReference(input.claimRef),
    themes: {
      model: theme.extraction.modelVersion,
      prompt: theme.extraction.promptVersion,
      schema: theme.extraction.schemaVersion,
    },
    claims: {
      model: claims.extraction.modelVersion,
      prompt: claims.extraction.promptVersion,
      schema: claims.schemaVersion,
    },
    counts: {
      themeProposals: theme.proposals.length,
      acceptedClaims: claims.claims.length,
      candidates: claims.candidates?.length ?? 0,
      rejected: claims.rejected.length,
    },
  };
  const eventId = postAnalysedEventId(input.themeRef, input.claimRef);
  const key = `analysed:${input.post.publicationId}/${input.post.postId}:${eventId}`;

  // Record durably in the outbox. Publishing is a separate step, so a broker
  // outage can never prevent the durable handoff from being saved.
  const claim = input.operations.claim(key, input.owner, 60_000, 3);
  let newlyRecorded = false;
  if (claim.kind === "busy") return { status: "busy" };
  const event = () =>
    createPostAnalysedEvent(data, { id: eventId, now: input.now ?? (() => new Date()) });
  if (claim.kind === "exhausted") {
    // Interrupted attempts left no completion record, but both results are
    // still valid: record the handoff with the state controller's atomic,
    // claim-free reconciliation so the saved analysis is never stranded.
    if (input.operations.pendingEventStatus(eventId) === undefined) {
      input.operations.reconcileCompleted(key, { eventId }, [
        { eventId, subject: POST_ANALYSED_SUBJECT, payload: JSON.stringify(event().toJSON()) },
      ]);
      newlyRecorded = true;
    }
  }
  if (claim.kind === "claimed") {
    input.operations.complete(claim.claim, { eventId }, [
      { eventId, subject: POST_ANALYSED_SUBJECT, payload: JSON.stringify(event().toJSON()) },
    ]);
    newlyRecorded = true;
  }

  return {
    status: "recorded",
    eventId,
    newlyRecorded,
    delivery: input.operations.pendingEventStatus(eventId) === "sent" ? "sent" : "pending",
    data,
  };
}

export type PublishOutcome = "sent" | "pending" | "missing";

/**
 * Publish the event recorded under `eventId`, if it is still pending. Purely
 * additive: a failed send leaves the event pending for a later run, and a
 * missing ID publishes nothing. The row is looked up by ID, so an unrelated
 * backlog can never crowd out the requested event.
 */
export async function publishRecordedEvent(
  operations: OperationStore,
  eventId: string,
  publisher: EventPublisher,
): Promise<PublishOutcome> {
  if (operations.pendingEventStatus(eventId) === "sent") return "sent";
  const pending = operations.pendingEvent(eventId);
  if (!pending) return "missing";
  try {
    await publisher.publish(pending.subject, new TextEncoder().encode(pending.payload), {
      msgId: pending.eventId,
    });
    operations.markEventSent(pending.eventId);
    return "sent";
  } catch {
    operations.markEventRetry(pending.eventId, 30_000);
    return "pending";
  }
}
