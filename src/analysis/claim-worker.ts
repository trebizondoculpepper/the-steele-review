import { createHash, randomUUID } from "node:crypto";
import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { CollectionRecordSchema } from "../collection/collection-store.js";
import { toArchiveRef } from "../collection/fulltext-projection.js";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { DeliveredMessage } from "../controllers/nats.js";
import type { OperationStore, PendingEventInput } from "../controllers/operation-store.js";
import { IngestionReasonSchema } from "../events/discovery-event.js";
import { parseTextReadyEvent } from "../events/text-ready-event.js";
import type { ClaimExtractor } from "./extraction.js";

/**
 * Claim extraction worker: text-ready event → versioned claim artifact →
 * `claims.extracted` handoff.
 *
 * - Deduplicated by source version, model and prompt: the operation key is
 *   built from them, so duplicate events reuse the stored result.
 * - The exact committed collection record is read through the archive
 *   controller; incomplete sources are recorded and not extracted.
 * - Extraction uses the #33 controller (bounded, grounded, fenced source).
 *   Incomplete extractions are stored with their rejections and flagged.
 * - The claim set is committed to Git, then completion and the pending
 *   handoff event are recorded in one transaction, then the input is
 *   acknowledged. A failed handoff stays pending and is retried with the same
 *   event ID by {@link ClaimExtractionWorker.dispatchPending}.
 * - No research, comparison or publication. Backfill reason is carried
 *   through unchanged.
 */

export const CLAIMS_EXTRACTED_EVENT_TYPE_V1 = "org.steele.claims.extracted.v1";
export const CLAIMS_EXTRACTED_SUBJECT = "steele.v1.claims.extracted";

export const ClaimsExtractedDataSchema = z
  .object({
    publicationId: z.string().min(1),
    postId: z.string().min(1),
    ingestionReason: IngestionReasonSchema,
    claimsArtifact: ArtifactReferenceSchema,
    sourceArtifact: ArtifactReferenceSchema,
    status: z.enum(["complete", "incomplete"]),
    claimCount: z.number().int().min(0),
    modelVersion: z.string().min(1),
    promptVersion: z.string().min(1),
  })
  .strict();
export type ClaimsExtractedData = z.infer<typeof ClaimsExtractedDataSchema>;

export type ClaimWorkerOutcome =
  | "extracted"
  | "already-extracted"
  | "busy"
  | "exhausted"
  | "incomplete-source"
  | "retry"
  | "failed"
  | "invalid-event";

export interface HandoffPublisher {
  publish(subject: string, payload: Uint8Array, options: { msgId: string }): Promise<unknown>;
}

export interface ClaimWorkerConfig {
  extractor: ClaimExtractor;
  /** Identity of the extractor's provider and prompt, used for deduplication. */
  modelVersion: string;
  promptVersion: string;
  /** Archive holding collection records and claim artifacts. */
  artifacts: GitArtifactStore;
  operations: OperationStore;
  publisher: HandoffPublisher;
  owner: string;
  leaseMs?: number;
  retryDelayMs?: number;
}

const short = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

const toReference = (ref: ArtifactRef): ArtifactReference => ({
  repository: ref.repository,
  commit: ref.commit,
  path: ref.path,
  hash: `sha256:${ref.sha256}`,
});

export class ClaimExtractionWorker {
  constructor(private readonly config: ClaimWorkerConfig) {}

  async handle(message: DeliveredMessage, signal?: AbortSignal): Promise<ClaimWorkerOutcome> {
    let event;
    try {
      event = parseTextReadyEvent(new TextDecoder().decode(message.data));
    } catch {
      message.term();
      return "invalid-event";
    }
    const data = event.data!;
    const retryDelay = this.config.retryDelayMs ?? 60_000;

    // Read the exact committed record.
    let record;
    try {
      record = CollectionRecordSchema.parse(
        JSON.parse(await this.config.artifacts.read(toArchiveRef(data.artifact))),
      );
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "git-failed") {
        message.nak(retryDelay);
        return "retry";
      }
      this.config.operations.recordPermanentFailure(
        `claims:invalid:${event.id}`,
        "unreadable-source",
      );
      await message.ack();
      return "failed";
    }
    if (record.item.publicationId !== data.publicationId || record.item.postId !== data.postId) {
      this.config.operations.recordPermanentFailure(
        `claims:invalid:${event.id}`,
        "identity-mismatch",
      );
      await message.ack();
      return "failed";
    }

    const sourceVersion = sourceVersionFor(record.text);
    const key = `claims:${sourceVersion}:${this.config.modelVersion}:${this.config.promptVersion}`;
    if (!record.complete) {
      this.config.operations.recordPermanentFailure(key, "incomplete-source");
      await message.ack();
      return "incomplete-source";
    }

    const claimed = this.config.operations.claim(
      key,
      this.config.owner,
      this.config.leaseMs ?? 30 * 60_000,
      5,
    );
    if (claimed.kind === "completed") {
      await message.ack();
      await this.dispatchPending();
      return "already-extracted";
    }
    if (claimed.kind === "busy") {
      message.nak(Math.max(1_000, claimed.leaseExpiresAt - Date.now()));
      return "busy";
    }
    if (claimed.kind === "exhausted") {
      await message.ack();
      return "exhausted";
    }
    const claim = claimed.claim;

    const result = await this.config.extractor.extract(
      { text: record.text, sourceVersion, artifact: data.artifact },
      signal,
    );
    if (result.status === "failed") {
      const permanent = result.reason === "source-too-large";
      this.config.operations.fail(claim, `extract:${result.reason}`, !permanent);
      if (permanent) {
        await message.ack();
        return "failed";
      }
      message.nak(retryDelay);
      return "retry";
    }

    const claimSet = {
      status: result.status,
      rejected: result.status === "incomplete" ? result.rejected : [],
      sourceVersion,
      sourceArtifact: data.artifact,
      modelVersion: result.modelVersion,
      promptVersion: result.promptVersion,
      claims: result.claims,
    };
    const path = `claims/${data.publicationId}/${data.postId}/${sourceVersion.slice(7, 39)}-${short(`${result.modelVersion}\n${result.promptVersion}`)}.json`;
    let artifact: ArtifactRef;
    let stored = claimSet;
    try {
      artifact = await this.config.artifacts.write(path, `${JSON.stringify(claimSet, null, 2)}\n`);
    } catch (error) {
      // A concurrent or earlier crashed attempt committed this path: keep its version.
      const existing =
        error instanceof ArtifactStoreError && error.code === "immutable-conflict"
          ? await this.config.artifacts.lookup(path)
          : undefined;
      if (!existing) {
        this.config.operations.fail(claim, "commit-failed", true);
        message.nak(retryDelay);
        return "retry";
      }
      artifact = existing;
      stored = JSON.parse(await this.config.artifacts.read(existing)) as typeof claimSet;
    }

    const handoff = new CloudEvent<ClaimsExtractedData>(
      {
        specversion: "1.0",
        id: randomUUID(),
        source: "urn:steele:claims:extractor",
        type: CLAIMS_EXTRACTED_EVENT_TYPE_V1,
        time: new Date().toISOString(),
        subject: `substack/${data.publicationId}/${data.postId}`,
        datacontenttype: "application/json",
        causationid: event.id,
        data: ClaimsExtractedDataSchema.parse({
          publicationId: data.publicationId,
          postId: data.postId,
          ingestionReason: data.ingestionReason,
          claimsArtifact: toReference(artifact),
          sourceArtifact: data.artifact,
          status: stored.status,
          claimCount: stored.claims.length,
          modelVersion: stored.modelVersion,
          promptVersion: stored.promptVersion,
        }),
      },
      true,
    );
    const pending: PendingEventInput = {
      eventId: handoff.id,
      subject: CLAIMS_EXTRACTED_SUBJECT,
      payload: JSON.stringify(handoff.toJSON()),
    };
    this.config.operations.complete(claim, { claimsArtifact: toReference(artifact) }, [pending]);
    await message.ack();
    await this.dispatchPending();
    return "extracted";
  }

  /** Publish pending handoff events; failures stay pending with the same ID. */
  async dispatchPending(limit = 100): Promise<number> {
    let sent = 0;
    for (const p of this.config.operations.duePendingEvents(limit)) {
      if (p.subject !== CLAIMS_EXTRACTED_SUBJECT) continue;
      try {
        await this.config.publisher.publish(p.subject, new TextEncoder().encode(p.payload), {
          msgId: p.eventId,
        });
        this.config.operations.markEventSent(p.eventId);
        sent++;
      } catch {
        this.config.operations.markEventRetry(p.eventId, this.config.retryDelayMs ?? 60_000);
      }
    }
    return sent;
  }
}
