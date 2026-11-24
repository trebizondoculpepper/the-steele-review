import type { CloudEvent } from "cloudevents";
import { sha256, type ArtifactRef, type GitArtifactStore } from "../controllers/artifact-store.js";
import type { CollectionRecord } from "../collection/collection-store.js";
import {
  retainEmbeddedImages,
  retainPreviewImage,
  type ImageFetcherPort,
  type PreviewRetentionOutcome,
} from "../collection/preview-retention.js";
import type { CollectorPort } from "../collection/worker.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import { contextArtifactReference } from "../content/source-context.js";
import type { SubstackItem } from "../content/substack-item.js";
import {
  createCapturedContentEvent,
  substackCapturedContent,
  type CapturedContentData,
} from "../events/captured-content-event.js";
import type { IngestionReason } from "../events/discovery-event.js";

/**
 * Source capture as one programmatic block (#865): no model calls.
 *
 * Internally the block fetches the source text and its available images,
 * saves them through the Git artifact store, and then emits the existing
 * source-ready (captured-content) event with exact artifact references.
 *
 * - One stable file per source: `substack/<publication>/<post>/source.json`,
 *   beside its content-addressed images. A changed source revises that file
 *   in place and Git keeps the history.
 * - The file holds only what article generation needs. Capture time,
 *   collector details, ingestion reason and retry state are left out, so a
 *   retry, a collector upgrade or a later timestamp alone writes identical
 *   bytes, which the store treats as a no-op: no new commit.
 * - The event is emitted only after the save is durable. Its ID is derived
 *   from the source and the exact saved file, so emitting again after an
 *   interruption, or resending deliberately, keeps the same logical identity
 *   and is deduplicated by the consumer.
 *
 * This is the pilot block; the live collection worker is unchanged. Keying
 * automatic article generation by post rather than text hash is separate
 * work, because it needs the processed backlog reconciled first.
 */

export const SOURCE_RECORD_SCHEMA_VERSION = 1;

/** What the saved source file contains: the material article generation needs. */
export interface SourceRecord {
  schemaVersion: typeof SOURCE_RECORD_SCHEMA_VERSION;
  item: {
    publicationId: string;
    postId: string;
    url: string;
    title?: string;
    publishedAt?: string;
    author?: string;
  };
  text: string;
  complete: boolean;
  supplied: CollectionRecord["supplied"];
  /** How the text was obtained, e.g. article HTML or a supplied transcript. */
  method: string;
  transcriptVariant?: string;
  previewImage?: CollectionRecord["previewImage"];
  images?: CollectionRecord["images"];
}

export interface SourceEventPublisher {
  /** Durable publication; must deduplicate by the event ID. */
  publish(event: CloudEvent<CapturedContentData>): Promise<void>;
}

export interface SourceCaptureDeps {
  collector: CollectorPort;
  artifacts: Pick<GitArtifactStore, "lookup" | "read" | "revise" | "writeBinary">;
  publisher: SourceEventPublisher;
  /** Image fetching; without it, images are left unretained and still referenced. */
  images?: ImageFetcherPort;
  now?: () => Date;
}

export type SourceCaptureOutcome =
  | {
      status: "saved" | "unchanged";
      ref: ArtifactRef;
      eventId: string;
      /** "not-fetched" when no image fetcher is configured. */
      preview: PreviewRetentionOutcome | "not-fetched";
      imagesFailed: number;
    }
  | { status: "not-captured"; reason: string };

export const sourcePath = (item: Pick<SubstackItem, "publicationId" | "postId">) =>
  `substack/${item.publicationId}/${item.postId}/source.json`;

/** Stable JSON: the same record always serialises to the same bytes. */
function serialise(record: SourceRecord): string {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, sort(v)]),
          )
        : value;
  return `${JSON.stringify(sort(record), null, 2)}\n`;
}

/** The source-ready event for one saved source file. */
function sourceEvent(
  record: SourceRecord,
  ref: ArtifactRef,
  reason: IngestionReason,
  now?: () => Date,
) {
  return createCapturedContentEvent(
    substackCapturedContent({
      artifact: contextArtifactReference(ref),
      record: {
        item: record.item,
        ingestionReason: reason,
        complete: record.complete,
        provenance: {
          method: record.method,
          ...(record.transcriptVariant ? { transcriptVariant: record.transcriptVariant } : {}),
        },
      },
      sourceVersion: sourceVersionFor(record.text),
    }),
    now,
  );
}

/** Fetch, save and announce one source. */
export async function captureSource(
  item: SubstackItem,
  deps: SourceCaptureDeps,
  options: { reason: IngestionReason; signal?: AbortSignal },
): Promise<SourceCaptureOutcome> {
  const signal = options.signal ?? new AbortController().signal;
  let acquired;
  try {
    acquired = await deps.collector.collect(item, signal);
  } catch {
    return { status: "not-captured", reason: "collector-error" };
  }
  if (acquired.kind !== "text") return { status: "not-captured", reason: acquired.kind };

  // Image retention works on the collection record shape; only its retained
  // references are carried into the stable source file.
  let collected: CollectionRecord = {
    item: { ...item, ...(acquired.item.author ? { author: acquired.item.author } : {}) },
    ingestionReason: options.reason,
    text: acquired.text,
    complete: acquired.complete,
    supplied: { ...acquired.supplied },
    ...(acquired.previewImage ? { previewImage: acquired.previewImage } : {}),
    provenance: { ...acquired.provenance },
  };
  let preview: PreviewRetentionOutcome | "not-fetched" = acquired.previewImage
    ? "not-fetched"
    : "no-preview";
  let imagesFailed = 0;
  if (deps.images) {
    const p = await retainPreviewImage(collected, {
      fetcher: deps.images,
      artifacts: deps.artifacts,
      signal,
    });
    collected = p.record;
    preview = p.outcome;
    const e = await retainEmbeddedImages(collected, {
      fetcher: deps.images,
      artifacts: deps.artifacts,
      signal,
    });
    collected = e.record;
    imagesFailed = e.report.failed;
  }

  const variant = acquired.provenance.transcriptVariant;
  const record: SourceRecord = {
    schemaVersion: SOURCE_RECORD_SCHEMA_VERSION,
    item: {
      publicationId: item.publicationId,
      postId: item.postId,
      url: item.url,
      ...(item.title ? { title: item.title } : {}),
      ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
      ...(collected.item.author ? { author: collected.item.author } : {}),
    },
    text: collected.text,
    complete: collected.complete,
    supplied: collected.supplied,
    method: acquired.provenance.method,
    ...(typeof variant === "string" ? { transcriptVariant: variant } : {}),
    ...(collected.previewImage ? { previewImage: collected.previewImage } : {}),
    ...(collected.images ? { images: collected.images } : {}),
  };

  // Save first; announce only what is durably saved.
  const path = sourcePath(item);
  const content = serialise(record);
  const existing = await deps.artifacts.lookup(path);
  const ref = await deps.artifacts.revise(path, content, existing?.sha256 ?? null);
  // Identical bytes: the store made no commit, and nothing about the source changed.
  const unchanged = existing?.sha256 === sha256(content);

  const event = sourceEvent(record, ref, options.reason, deps.now);
  await deps.publisher.publish(event);
  return {
    status: unchanged ? "unchanged" : "saved",
    ref,
    eventId: event.id,
    preview,
    imagesFailed,
  };
}

/**
 * Resend the source-ready event for what is saved now, without fetching. The
 * saved file and so the event's logical identity are the same as the last
 * capture's; the consumer deduplicates it. Regenerating an article is a
 * separate, explicit request.
 */
export async function resendSource(
  item: Pick<SubstackItem, "publicationId" | "postId">,
  deps: Pick<SourceCaptureDeps, "artifacts" | "publisher" | "now">,
  options: { reason: IngestionReason },
): Promise<{ status: "resent"; ref: ArtifactRef; eventId: string } | { status: "not-saved" }> {
  const ref = await deps.artifacts.lookup(sourcePath(item));
  if (!ref) return { status: "not-saved" };
  const record = JSON.parse(await deps.artifacts.read(ref)) as SourceRecord;
  const event = sourceEvent(record, ref, options.reason, deps.now);
  await deps.publisher.publish(event);
  return { status: "resent", ref, eventId: event.id };
}
