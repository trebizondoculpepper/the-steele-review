import { createHash } from "node:crypto";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  POST_ANALYSED_SUBJECT,
  createPostAnalysedEvent,
  type PostAnalysedData,
} from "../events/post-analysed-event.js";
import { ClaimExtractionRecordSchema } from "./grounded-claims.js";
import { parseThemeProposalResult } from "./theme-proposals.js";

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
  publisher?: EventPublisher;
  now?: () => Date;
}): Promise<AnnounceOutcome> {
  let theme;
  try {
    theme = parseThemeProposalResult(JSON.parse(await input.content.read(input.themeRef)));
  } catch {
    return { status: "refused", reason: "unreadable-theme-result" };
  }
  let claims;
  try {
    claims = ClaimExtractionRecordSchema.parse(
      JSON.parse(await input.content.read(input.claimRef)),
    );
  } catch {
    return { status: "refused", reason: "unreadable-claim-result" };
  }
  // Only results under the current accepted/candidate contract complete a post.
  if (claims.schemaVersion !== 2) return { status: "refused", reason: "legacy-claim-result" };
  const samePost = (p: { publicationId: string; postId: string }) =>
    p.publicationId === input.post.publicationId && p.postId === input.post.postId;
  if (!samePost(theme.post) || !samePost(claims.post))
    return { status: "refused", reason: "post-mismatch" };
  if (theme.sourceVersion !== claims.sourceVersion) {
    return { status: "refused", reason: "source-version-mismatch" };
  }
  if (claims.themeResult !== short(input.themeRef)) {
    return { status: "refused", reason: "theme-result-not-linked" };
  }

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

  // Record durably first (the outbox), then publish separately.
  const claim = input.operations.claim(key, input.owner, 60_000, 3);
  let newlyRecorded = false;
  if (claim.kind === "busy") return { status: "busy" };
  if (claim.kind === "claimed") {
    const event = createPostAnalysedEvent(data, {
      id: eventId,
      now: input.now ?? (() => new Date()),
    });
    input.operations.complete(claim.claim, { eventId }, [
      { eventId, subject: POST_ANALYSED_SUBJECT, payload: JSON.stringify(event.toJSON()) },
    ]);
    newlyRecorded = true;
  }

  const pending = input.operations
    .duePendingEvents(1_000, POST_ANALYSED_SUBJECT)
    .find((e) => e.eventId === eventId);
  if (pending && input.publisher) {
    try {
      await input.publisher.publish(pending.subject, new TextEncoder().encode(pending.payload), {
        msgId: pending.eventId,
      });
      input.operations.markEventSent(pending.eventId);
    } catch {
      input.operations.markEventRetry(pending.eventId, 30_000);
    }
  }
  return {
    status: "recorded",
    eventId,
    newlyRecorded,
    delivery: input.operations.pendingEventStatus(eventId) === "sent" ? "sent" : "pending",
    data,
  };
}
