import { ObservedDateSchema, OriginalMediumSchema } from "../content/source-context.js";
import { z } from "zod";
import { SubstackItemSchema, type SubstackItem } from "../content/substack-item.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type {
  ClaimResult,
  OperationClaim,
  OperationStore,
  PendingEventInput,
} from "../controllers/operation-store.js";

/**
 * Collection state and versioned text archive, integrating the SQLite
 * operation store (#22) with the Git artifact store (#21).
 *
 * Ordering for one post:
 *   1. claim the stable collection key (one collector at a time);
 *   2. commit the text/provenance artifact to Git (durable, immutable);
 *   3. record completion plus pending downstream events in one SQLite
 *      transaction, referencing the committed artifact.
 *
 * Completion is recorded only after the artifact is durable. If a collector
 * crashes between steps 2 and 3, the artifact remains; the next attempt finds
 * it at the same predictable path and completes with that first durable
 * version rather than writing a competing one. SQLite and NATS never share a
 * transaction: published events are marked sent separately.
 *
 * Text and provenance only: the record schema has no media fields and
 * rejects unknown ones.
 */

/** Transcript segment; times are present only when the source supplied them. */
const SegmentSchema = z
  .object({
    start: z.number().nonnegative().optional(),
    end: z.number().nonnegative().optional(),
    text: z.string(),
  })
  .strict();

/** Post-specific preview image reference; never the publication's own branding. */
export const PreviewImageSchema = z
  .object({
    url: z.url({ protocol: /^https$/ }),
    source: z.literal("cover_image"),
    kind: z.enum(["video-frame", "uploaded"]),
  })
  .strict();
export type PreviewImage = z.infer<typeof PreviewImageSchema>;

/** Retained collection record: text and provenance, never media. */
export const CollectionRecordSchema = z
  .object({
    item: SubstackItemSchema,
    ingestionReason: z.enum(["live", "backfill", "reprocess"]),
    text: z.string().min(1),
    complete: z.boolean(),
    supplied: z
      .object({
        articleHtml: z.string().optional(),
        transcript: z.array(SegmentSchema).optional(),
        transcriptDocument: z.string().optional(),
      })
      .strict(),
    /** The post's own preview image (#277); absent when it is not post-specific. */
    previewImage: PreviewImageSchema.optional(),
    provenance: z.looseObject({
      sourceUrl: z.url(),
      acquiredAt: z.iso.datetime({ offset: true }),
      method: z.string().min(1),
      originalMedium: OriginalMediumSchema.optional(),
      originalMediaUploadId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,200}$/)
        .optional(),
      mediaUploadKind: z.enum(["audio", "video"]).optional(),
      observedPublishedAt: ObservedDateSchema.optional(),
      observedUpdatedAt: ObservedDateSchema.optional(),
    }),
  })
  .strict();
export type CollectionRecord = z.infer<typeof CollectionRecordSchema>;

/** Stable operation key for collecting one post. */
export function collectionKey(item: Pick<SubstackItem, "publicationId" | "postId">): string {
  return `collect:substack/${item.publicationId}/${item.postId}`;
}

/** Predictable artifact path for one post's collected text. */
export function collectionArtifactPath(
  item: Pick<SubstackItem, "publicationId" | "postId">,
): string {
  return `substack/${item.publicationId}/${item.postId}/collected.json`;
}

export interface CommitResult {
  artifact: ArtifactRef;
  /** True when an artifact left by an interrupted attempt was reused. */
  reconciled: boolean;
}

export class CollectionStore {
  constructor(
    private readonly operations: OperationStore,
    private readonly artifacts: GitArtifactStore,
  ) {}

  /**
   * Claim collection of a post, or learn that it is done, busy or exhausted.
   * An exhausted operation whose artifact was committed before a crash is
   * completed from that artifact rather than abandoned.
   */
  async begin(
    item: SubstackItem,
    owner: string,
    leaseMs: number,
    options: {
      maxAttempts?: number;
      /** Builds events for a reconciled orphan from the record it actually contains. */
      eventsFor: (artifact: ArtifactRef, record: CollectionRecord) => PendingEventInput[];
    },
  ): Promise<ClaimResult> {
    const key = collectionKey(item);
    const result = this.operations.claim(key, owner, leaseMs, options.maxAttempts);
    if (result.kind !== "exhausted") return result;
    const orphan = await this.existing(item);
    if (!orphan) return result;
    const artifact = this.operations.reconcileCompleted(
      key,
      orphan.artifact,
      options.eventsFor(orphan.artifact, orphan.record),
    );
    return { kind: "completed", artifact };
  }

  /**
   * The committed artifact and record for a post, if an earlier attempt
   * committed one (whether or not its completion was recorded).
   */
  async existing(
    item: Pick<SubstackItem, "publicationId" | "postId">,
  ): Promise<{ artifact: ArtifactRef; record: CollectionRecord } | undefined> {
    const artifact = await this.artifacts.lookup(collectionArtifactPath(item));
    if (!artifact) return undefined;
    return { artifact, record: await this.read(artifact) };
  }

  /**
   * Commit the record durably, then record completion with the pending
   * events built from the committed reference. Safe to retry.
   */
  async commit(
    claim: OperationClaim,
    record: CollectionRecord,
    eventsFor: (artifact: ArtifactRef) => PendingEventInput[],
  ): Promise<CommitResult> {
    const valid = CollectionRecordSchema.parse(record);
    if (claim.key !== collectionKey(valid.item)) {
      throw new Error("claim does not match record item");
    }
    const path = collectionArtifactPath(valid.item);
    const content = `${JSON.stringify(valid, null, 2)}\n`;

    let artifact: ArtifactRef;
    let reconciled = false;
    try {
      artifact = await this.artifacts.write(path, content);
    } catch (error) {
      if (!(error instanceof ArtifactStoreError) || error.code !== "immutable-conflict") {
        throw error;
      }
      // An interrupted earlier attempt already committed this post: keep that version.
      const existing = await this.artifacts.lookup(path);
      if (!existing) throw error;
      artifact = existing;
      reconciled = true;
    }
    this.operations.complete(claim, artifact, eventsFor(artifact));
    return { artifact, reconciled };
  }

  /** Release a failed attempt; retryable failures stay claimable until attempts run out. */
  fail(claim: OperationClaim, errorCode: string, retryable: boolean): void {
    this.operations.fail(claim, errorCode, retryable);
  }

  /** Read a completed record back from its exact committed version. */
  async read(artifact: ArtifactRef): Promise<CollectionRecord> {
    return CollectionRecordSchema.parse(JSON.parse(await this.artifacts.read(artifact)));
  }
}
