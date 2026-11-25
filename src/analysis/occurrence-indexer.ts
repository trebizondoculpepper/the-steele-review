import { z } from "zod";
import { CollectionRecordSchema } from "../collection/collection-store.js";
import { toArchiveRef } from "../collection/fulltext-projection.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import {
  ArtifactStoreError,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { DeliveredMessage } from "../controllers/nats.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { InvalidClaimError, parseClaim } from "./claim.js";
import {
  CLAIM_OCCURRENCE_INDEX_V1,
  InvalidClaimOccurrenceError,
  createClaimOccurrence,
  type ClaimOccurrence,
} from "./claim-occurrence.js";
import {
  CLAIMS_EXTRACTED_EVENT_TYPE_V1,
  ClaimsExtractedDataSchema,
} from "./claim-worker.js";

/**
 * Index grounded claim occurrences (#80) from `claims.extracted` events.
 *
 * - Reads the exact committed claim set and source record through the archive
 *   controller, re-validates every claim against the source (#32), and builds
 *   one occurrence per claim with the #79 contract.
 * - Writes each occurrence to the dedicated claim-occurrence index under its
 *   deterministic occurrence ID, so retries and overlapping backfill never add
 *   duplicate counts.
 * - Attribution is recorded as `unknown`: the claim set carries no speaker
 *   evidence, so none is inferred, and the post author is never assumed to be
 *   the speaker. Nothing is marked true or false.
 * - The input is acknowledged only after every valid occurrence is indexed;
 *   a retryable index failure redelivers (already indexed IDs are rewritten
 *   in place). Invalid claims are skipped and counted, never indexed.
 */

export type OccurrenceIndexOutcome =
  | { kind: "indexed"; indexed: number; skipped: number }
  | { kind: "already-indexed" }
  | { kind: "retry"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "invalid-event" };

export interface OccurrenceIndexPort {
  indexDocument(index: string, id: string, document: unknown): Promise<unknown>;
}

export interface OccurrenceIndexerConfig {
  artifacts: Pick<GitArtifactStore, "read">;
  index: OccurrenceIndexPort;
  indexName?: string;
  operations: OperationStore;
  owner: string;
  retryDelayMs?: number;
}

const ClaimSetSchema = z.looseObject({
  claims: z.array(z.unknown()),
  sourceArtifact: z.unknown(),
});

const EventSchema = z
  .looseObject({
    specversion: z.literal("1.0"),
    id: z.string().min(1).max(200),
    source: z.string().min(1).max(500),
    type: z.literal(CLAIMS_EXTRACTED_EVENT_TYPE_V1),
    subject: z.string().min(1).max(500),
    datacontenttype: z.literal("application/json").optional(),
    data: ClaimsExtractedDataSchema,
  })
  .refine(
    (e) => e.subject === `substack/${e.data.publicationId}/${e.data.postId}`,
    {
      message: "subject does not match the post",
    },
  );

export class OccurrenceIndexer {
  constructor(private readonly config: OccurrenceIndexerConfig) {}

  async handle(message: DeliveredMessage): Promise<OccurrenceIndexOutcome> {
    const { operations } = this.config;
    let event;
    try {
      event = EventSchema.parse(
        JSON.parse(new TextDecoder().decode(message.data)),
      );
    } catch {
      message.term();
      return { kind: "invalid-event" };
    }
    const data = event.data;
    const retryDelay = this.config.retryDelayMs ?? 30_000;
    // Read and check identity before touching the shared operation, so a
    // malformed delivery can never fail the work for a valid one.
    let claimSet;
    let record;
    try {
      claimSet = ClaimSetSchema.parse(
        JSON.parse(
          await this.config.artifacts.read(toArchiveRef(data.claimsArtifact)),
        ),
      );
      record = CollectionRecordSchema.parse(
        JSON.parse(
          await this.config.artifacts.read(toArchiveRef(data.sourceArtifact)),
        ),
      );
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "git-failed") {
        message.nak(retryDelay);
        return { kind: "retry", reason: "archive-read-failed" };
      }
      operations.recordPermanentFailure(
        `occ-invalid:${event.id}`,
        "unreadable-artifact",
      );
      await message.ack();
      return { kind: "failed", reason: "unreadable-artifact" };
    }
    if (
      record.item.publicationId !== data.publicationId ||
      record.item.postId !== data.postId ||
      JSON.stringify(claimSet.sourceArtifact) !==
        JSON.stringify(data.sourceArtifact)
    ) {
      operations.recordPermanentFailure(
        `occ-invalid:${event.id}`,
        "identity-mismatch",
      );
      await message.ack();
      return { kind: "failed", reason: "identity-mismatch" };
    }

    const key = `occ-index:${data.claimsArtifact.hash}`;
    const claimed = operations.claim(key, this.config.owner, 10 * 60_000, 10);
    if (claimed.kind === "completed") {
      await message.ack();
      return { kind: "already-indexed" };
    }
    if (claimed.kind === "busy") {
      message.nak(Math.max(1_000, claimed.leaseExpiresAt - Date.now()));
      return { kind: "retry", reason: "busy" };
    }
    if (claimed.kind === "exhausted") {
      await message.ack();
      return { kind: "failed", reason: "exhausted" };
    }
    const claim = claimed.claim;

    const source = {
      text: record.text,
      sourceVersion: sourceVersionFor(record.text),
      artifact: data.sourceArtifact,
      publicationId: data.publicationId,
      postId: data.postId,
      url: record.item.url,
      ...(record.item.publishedAt
        ? { publishedAt: record.item.publishedAt }
        : {}),
    };
    const occurrences: ClaimOccurrence[] = [];
    let skipped = 0;
    for (const raw of claimSet.claims) {
      try {
        const claimValue = parseClaim(raw, source);
        occurrences.push(
          createClaimOccurrence({
            claim: claimValue,
            source,
            speaker: { kind: "unknown" },
          }),
        );
      } catch (error) {
        if (
          error instanceof InvalidClaimError ||
          error instanceof InvalidClaimOccurrenceError ||
          error instanceof z.ZodError
        ) {
          skipped++;
          continue;
        }
        throw error;
      }
    }

    for (const occurrence of occurrences) {
      try {
        await this.config.index.indexDocument(
          this.config.indexName ?? CLAIM_OCCURRENCE_INDEX_V1,
          occurrence.occurrenceId,
          occurrence,
        );
      } catch (error) {
        const retryable =
          (error as { retryable?: boolean }).retryable !== false;
        const reason =
          (error as { category?: string }).category ?? "index-failed";
        operations.fail(claim, `occ-index:${reason}`, retryable);
        if (retryable) {
          message.nak(retryDelay);
          return { kind: "retry", reason };
        }
        await message.ack();
        return { kind: "failed", reason };
      }
    }
    operations.complete(claim, { indexed: occurrences.length, skipped }, []);
    await message.ack();
    return { kind: "indexed", indexed: occurrences.length, skipped };
  }
}
