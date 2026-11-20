import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { DeliveredMessage } from "../controllers/nats.js";
import type { OperationStore, PendingEventInput } from "../controllers/operation-store.js";
import {
  CLAIM_OCCURRED_SUBJECT,
  createClaimOccurredEvent,
  type ClaimOccurredData,
} from "../events/claim-occurred-event.js";
import { parsePostAnalysedEnvelope } from "../events/post-analysed-event.js";
import {
  THEME_OCCURRED_SUBJECT,
  createThemeOccurredEvent,
  type ThemeOccurredData,
} from "../events/theme-occurred-event.js";
import { readAnalysisPair, type AnalysisRefusal } from "./analysis-pair.js";
import type { PostAnalysedData } from "../events/post-analysed-event.js";
import type { ClaimExtractionRecord } from "./grounded-claims.js";
import type { ThemeProposalResult } from "./theme-proposals.js";

/**
 * Fan out one analysed post into per-theme and per-claim occurrence events
 * (#179).
 *
 * The aggregate post-analysed event stays the completion handoff. This
 * consumer reads its exact saved results again, validates them and records one
 * logical event per detected theme occurrence and per accepted claim
 * occurrence in the same durable outbox transaction. Publishing is a separate
 * step, so a restart or broker outage resumes with the same event IDs.
 *
 * Idempotency: the operation key is the parent analysis identity, so a
 * duplicate parent delivery finds the completed operation and records nothing
 * new. A repeated theme or claim in a later post is a different parent and a
 * different occurrence, as intended for research deduplication.
 *
 * No model calls, no research, no retrieval: only saved artifacts are read.
 */

const HEX = /^sha256:[0-9a-f]{64}$/;
const OccurrenceIdentity = z.looseObject({ occurrenceId: z.string().min(1).max(200) });

export type FanOutRefusal = AnalysisRefusal | "unidentified-claim-occurrence";

const toRef = (reference: ArtifactReference): ArtifactRef => ({
  repository: reference.repository,
  commit: reference.commit,
  path: reference.path,
  sha256: reference.hash.replace(/^sha256:/, ""),
});

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Stable event ID for one occurrence of one parent analysis. */
export function occurrenceEventId(
  kind: "theme" | "claim",
  parentId: string,
  occurrenceKey: string,
): string {
  return `${kind}-${digest([kind, parentId, occurrenceKey]).slice(0, 32)}`;
}

export interface OccurrenceInputs {
  post: { publicationId: string; postId: string };
  /** CloudEvents ID of the post-analysed parent, used as causation. */
  parentId: string;
  sourceVersion: string;
  sourceArtifact: ArtifactReference;
  themeResult: ArtifactReference;
  claimResult: ArtifactReference;
  theme: ThemeProposalResult;
  claims: ClaimExtractionRecord;
  now: () => Date;
}

export type OccurrenceEvents =
  | { status: "ok"; events: PendingEventInput[] }
  | { status: "refused"; reason: FanOutRefusal };

/**
 * Build the occurrence events for one validated analysis pair. Deterministic:
 * the same inputs always yield the same event IDs and order, so a redelivered
 * parent cannot create a second logical occurrence.
 */
export function buildOccurrenceEvents(input: OccurrenceInputs): OccurrenceEvents {
  if (!HEX.test(input.sourceVersion)) {
    return { status: "refused", reason: "unreadable-claim-result" };
  }
  const themeBase = {
    publicationId: input.post.publicationId,
    postId: input.post.postId,
    sourceVersion: input.sourceVersion,
    sourceArtifact: input.sourceArtifact,
    themeResult: input.themeResult,
    claimResult: input.claimResult,
  };
  const events: PendingEventInput[] = [];
  for (const proposal of input.theme.proposals) {
    const occurrenceId = `theme-occ-${digest([input.themeResult, proposal.id]).slice(0, 24)}`;
    const data: ThemeOccurredData = {
      ...themeBase,
      occurrenceId,
      theme: {
        id: proposal.id,
        title: proposal.title,
        ...(proposal.description ? { description: proposal.description } : {}),
      },
    };
    events.push({
      eventId: occurrenceEventId("theme", input.parentId, occurrenceId),
      subject: THEME_OCCURRED_SUBJECT,
      payload: JSON.stringify(
        createThemeOccurredEvent(data, {
          id: occurrenceEventId("theme", input.parentId, occurrenceId),
          now: input.now,
          causationId: input.parentId,
        }).toJSON(),
      ),
    });
  }
  for (const claim of input.claims.claims) {
    const occurrence = OccurrenceIdentity.safeParse(claim.occurrence);
    if (!occurrence.success) {
      return { status: "refused", reason: "unidentified-claim-occurrence" };
    }
    const occurrenceId = occurrence.data.occurrenceId;
    const data: ClaimOccurredData = {
      ...themeBase,
      occurrenceId,
      ...(claim.claimRecordId ? { claimId: claim.claimRecordId } : {}),
      kind: claim.kind,
      themeIds: claim.themeIds,
    };
    events.push({
      eventId: occurrenceEventId("claim", input.parentId, occurrenceId),
      subject: CLAIM_OCCURRED_SUBJECT,
      payload: JSON.stringify(
        createClaimOccurredEvent(data, {
          id: occurrenceEventId("claim", input.parentId, occurrenceId),
          now: input.now,
          causationId: input.parentId,
        }).toJSON(),
      ),
    });
  }
  return { status: "ok", events };
}

export interface OccurrencePublisher {
  publish(subject: string, payload: Uint8Array, options: { msgId: string }): Promise<unknown>;
}

export interface FanOutConfig {
  /** Repository holding the saved analysis artifacts (read only). */
  content: Pick<GitArtifactStore, "read">;
  operations: OperationStore;
  publisher: OccurrencePublisher;
  owner: string;
  leaseMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
  /** Sanitised status line per handled message; never carries content. */
  onDecision?: (decision: {
    outcome: FanOutOutcome;
    postId: string;
    themeEvents: number;
    claimEvents: number;
  }) => void;
}

export type FanOutOutcome =
  | "fanned-out"
  | "already-fanned-out"
  | "refused"
  | "busy"
  | "exhausted"
  | "retry"
  | "invalid-event";

/** Operation key: one fan-out per exact parent analysis. */
export const fanOutOperationKey = (data: {
  publicationId: string;
  postId: string;
  themeResult: ArtifactReference;
  claimResult: ArtifactReference;
}): string =>
  `fanout:${data.publicationId}/${data.postId}:${data.themeResult.commit}:${data.themeResult.path}:${data.claimResult.commit}:${data.claimResult.path}`;

export class AnalysisFanOut {
  constructor(private readonly config: FanOutConfig) {}

  private report(
    outcome: FanOutOutcome,
    postId: string,
    events: PendingEventInput[] = [],
  ): FanOutOutcome {
    this.config.onDecision?.({
      outcome,
      postId,
      themeEvents: events.filter((e) => e.subject === THEME_OCCURRED_SUBJECT).length,
      claimEvents: events.filter((e) => e.subject === CLAIM_OCCURRED_SUBJECT).length,
    });
    return outcome;
  }

  async handle(message: DeliveredMessage): Promise<FanOutOutcome> {
    let event: { id: string; data: PostAnalysedData };
    try {
      event = parsePostAnalysedEnvelope(new TextDecoder().decode(message.data));
    } catch {
      message.term();
      return this.report("invalid-event", "unknown");
    }
    const { id: parentId, data: parent } = event;
    const key = fanOutOperationKey(parent);
    const now = this.config.now ?? (() => new Date());
    const existing = this.config.operations.operationStatus(key);
    if (existing?.status === "completed") {
      await message.ack();
      await this.dispatchPending();
      return this.report("already-fanned-out", parent.postId);
    }

    const pair = await readAnalysisPair(
      this.config.content,
      { publicationId: parent.publicationId, postId: parent.postId },
      toRef(parent.themeResult),
      toRef(parent.claimResult),
    );
    if (pair.status === "refused") {
      // Saved results that cannot complete an analysis are permanent: never
      // research or fan out on unvalidated material.
      this.config.operations.recordPermanentFailure(key, `fan-out:${pair.reason}`);
      await message.ack();
      return this.report("refused", parent.postId);
    }
    const built = buildOccurrenceEvents({
      post: { publicationId: parent.publicationId, postId: parent.postId },
      parentId,
      sourceVersion: pair.theme.sourceVersion,
      sourceArtifact: parent.sourceArtifact,
      themeResult: parent.themeResult,
      claimResult: parent.claimResult,
      theme: pair.theme,
      claims: pair.claims,
      now,
    });
    if (built.status === "refused") {
      this.config.operations.recordPermanentFailure(key, `fan-out:${built.reason}`);
      await message.ack();
      return this.report("refused", parent.postId);
    }

    const claimed = this.config.operations.claim(
      key,
      this.config.owner,
      this.config.leaseMs ?? 30 * 60_000,
      3,
    );
    if (claimed.kind === "completed") {
      await message.ack();
      await this.dispatchPending();
      return this.report("already-fanned-out", parent.postId);
    }
    if (claimed.kind === "busy") {
      message.nak(Math.max(1_000, claimed.leaseExpiresAt - Date.now()));
      return this.report("busy", parent.postId);
    }
    if (claimed.kind === "exhausted") {
      await message.ack();
      return this.report("exhausted", parent.postId);
    }

    // Completion and every occurrence event are recorded in one transaction,
    // so nothing is lost between saving state and announcing it.
    this.config.operations.complete(
      claimed.claim,
      { parentEventId: parentId, occurrenceEvents: built.events.length },
      built.events,
    );
    await message.ack();
    await this.dispatchPending();
    return this.report("fanned-out", parent.postId, built.events);
  }

  /** Publish pending occurrence events; failures stay pending with the same ID. */
  async dispatchPending(limit = 200): Promise<number> {
    let sent = 0;
    for (const subject of [THEME_OCCURRED_SUBJECT, CLAIM_OCCURRED_SUBJECT]) {
      for (const pending of this.config.operations.duePendingEvents(limit, subject)) {
        try {
          await this.config.publisher.publish(
            pending.subject,
            new TextEncoder().encode(pending.payload),
            { msgId: pending.eventId },
          );
          this.config.operations.markEventSent(pending.eventId);
          sent++;
        } catch {
          this.config.operations.markEventRetry(
            pending.eventId,
            this.config.retryDelayMs ?? 60_000,
          );
        }
      }
    }
    return sent;
  }
}
