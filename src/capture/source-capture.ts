import {
  sha256,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  CollectionRecordSchema,
  type CollectionRecord,
} from "../collection/collection-store.js";
import {
  retainEmbeddedImages,
  retainPreviewImage,
  type ImageFetcherPort,
  type PreviewRetentionOutcome,
} from "../collection/preview-retention.js";
import type {
  CollectorPort,
  EventPublisherPort,
} from "../collection/worker.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import { contextArtifactReference } from "../content/source-context.js";
import type { SubstackItem } from "../content/substack-item.js";
import {
  CAPTURED_CONTENT_SUBJECT,
  createCapturedContentEvent,
  substackCapturedContent,
} from "../events/captured-content-event.js";
import type { IngestionReason } from "../events/discovery-event.js";

/**
 * Source capture as one programmatic block (#865): no model calls.
 *
 * Internally the block fetches the source text and its available images,
 * saves them through the Git artifact store, records the source-ready
 * (captured-content) announcement durably, and then publishes it.
 *
 * - One stable file per source: `substack/<publication>/<post>/source.json`,
 *   beside its content-addressed images. A changed source revises that file
 *   in place and Git keeps the history.
 * - The file is a valid capture record, so every existing consumer reads it.
 *   Its capture time and ingestion reason are those of the version that first
 *   produced the current content: a retry, a collector upgrade or a later
 *   fetch of the same content leaves the file byte-identical, so the store
 *   makes no commit.
 * - The announcement for each saved version is recorded in the state outbox
 *   before it is published, keyed by that exact version. A failed publish
 *   stays pending, and every later capture first replays what is pending, so
 *   an earlier version's announcement is never lost to a refetch. Event IDs
 *   are derived from the saved file, so a replay or a deliberate resend keeps
 *   the same logical identity.
 *
 * This is the pilot block; the live collection worker is unchanged. Keying
 * automatic article generation by post rather than text hash is #870.
 */

export interface SourceCaptureDeps {
  collector: CollectorPort;
  artifacts: Pick<
    GitArtifactStore,
    "lookup" | "read" | "revise" | "writeBinary"
  >;
  /** The state controller's outbox: announcements are recorded here first. */
  operations: Pick<
    OperationStore,
    | "reconcileCompleted"
    | "duePendingEvents"
    | "markEventSent"
    | "markEventRetry"
    | "pendingEventStatus"
  >;
  publisher: EventPublisherPort;
  /** Image fetching; without it, images are referenced but not retained. */
  images?: ImageFetcherPort;
  now?: () => Date;
  retryDelayMs?: number;
}

export type SourceCaptureOutcome =
  | {
      status: "saved" | "unchanged";
      ref: ArtifactRef;
      eventId: string;
      /** Whether this version's announcement has been published, or is still pending a retry. */
      announced: boolean;
      /** "not-fetched" when no image fetcher is configured. */
      preview: PreviewRetentionOutcome | "not-fetched";
      imagesFailed: number;
    }
  | { status: "not-captured"; reason: string };

export const sourcePath = (
  item: Pick<SubstackItem, "publicationId" | "postId">,
) => `substack/${item.publicationId}/${item.postId}/source.json`;

/** The outbox operation key for announcing one saved version of one source. */
const announceKey = (ref: Pick<ArtifactRef, "path" | "sha256">) =>
  `capture-source:${ref.path}@${ref.sha256}`;

/** Stable JSON: the same record always serialises to the same bytes. */
function serialise(record: CollectionRecord): string {
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

/** The part of a record that says what the source is, without when or why it was fetched. */
function content(record: CollectionRecord): string {
  const { ingestionReason: _reason, provenance, ...rest } = record;
  const { acquiredAt: _at, ...stable } = provenance;
  return serialise({ ...rest, provenance: stable } as never);
}

/** The pending announcement for one saved version. */
function announcement(
  record: CollectionRecord,
  ref: ArtifactRef,
  now?: () => Date,
) {
  const event = createCapturedContentEvent(
    substackCapturedContent({
      artifact: contextArtifactReference(ref),
      record,
      sourceVersion: sourceVersionFor(record.text),
    }),
    now,
  );
  return {
    eventId: event.id,
    subject: CAPTURED_CONTENT_SUBJECT,
    payload: JSON.stringify(event.toJSON()),
  };
}

const encoder = new TextEncoder();

/**
 * Publish pending source announcements, oldest first. Each is marked sent
 * only after the broker acknowledges it; a failure stays pending with the
 * same event ID. With `only`, just that source's announcements are sent.
 */
export async function dispatchPendingSources(
  deps: Pick<SourceCaptureDeps, "operations" | "publisher" | "retryDelayMs">,
  only?: Pick<SubstackItem, "publicationId" | "postId">,
): Promise<{ sent: string[]; failed: string[] }> {
  const prefix = only
    ? `capture-source:${sourcePath(only)}@`
    : "capture-source:";
  const out = { sent: [] as string[], failed: [] as string[] };
  for (const pending of deps.operations.duePendingEvents(
    100,
    CAPTURED_CONTENT_SUBJECT,
  )) {
    if (!pending.operationKey.startsWith(prefix)) continue;
    try {
      await deps.publisher.publish(
        pending.subject,
        encoder.encode(pending.payload),
        {
          msgId: pending.eventId,
        },
      );
      deps.operations.markEventSent(pending.eventId);
      out.sent.push(pending.eventId);
    } catch {
      deps.operations.markEventRetry(
        pending.eventId,
        deps.retryDelayMs ?? 30_000,
      );
      out.failed.push(pending.eventId);
    }
  }
  return out;
}

/** Fetch, save and announce one source. */
export async function captureSource(
  item: SubstackItem,
  deps: SourceCaptureDeps,
  options: { reason: IngestionReason; signal?: AbortSignal },
): Promise<SourceCaptureOutcome> {
  // Announcements left pending by an earlier capture go out first, so a
  // changed source can never displace the announcement of an earlier version.
  await dispatchPendingSources(deps, item);

  const signal = options.signal ?? new AbortController().signal;
  let acquired;
  try {
    acquired = await deps.collector.collect(item, signal);
  } catch {
    return { status: "not-captured", reason: "collector-error" };
  }
  if (acquired.kind !== "text")
    return { status: "not-captured", reason: acquired.kind };

  const now = deps.now ?? (() => new Date());
  const variant = acquired.provenance.transcriptVariant;
  let record: CollectionRecord = {
    item: {
      ...item,
      ...(acquired.item.author ? { author: acquired.item.author } : {}),
    },
    ingestionReason: options.reason,
    text: acquired.text,
    complete: acquired.complete,
    supplied: { ...acquired.supplied },
    ...(acquired.previewImage ? { previewImage: acquired.previewImage } : {}),
    // Only what identifies how the text was obtained; collector details stay out.
    provenance: {
      sourceUrl: acquired.provenance.sourceUrl,
      acquiredAt: now().toISOString(),
      method: acquired.provenance.method,
      ...(typeof variant === "string" ? { transcriptVariant: variant } : {}),
    },
  };
  let preview: PreviewRetentionOutcome | "not-fetched" = acquired.previewImage
    ? "not-fetched"
    : "no-preview";
  let imagesFailed = 0;
  if (deps.images) {
    const p = await retainPreviewImage(record, {
      fetcher: deps.images,
      artifacts: deps.artifacts,
      signal,
    });
    record = p.record;
    preview = p.outcome;
    const e = await retainEmbeddedImages(record, {
      fetcher: deps.images,
      artifacts: deps.artifacts,
      signal,
    });
    record = e.record;
    imagesFailed = e.report.failed;
  }

  // Same content as the saved version: keep its bytes, capture time and reason.
  const path = sourcePath(item);
  const existing = await deps.artifacts.lookup(path);
  if (existing) {
    const saved = CollectionRecordSchema.safeParse(
      JSON.parse(await deps.artifacts.read(existing)),
    );
    if (saved.success && content(saved.data) === content(record))
      record = saved.data;
    else if (saved.success) {
      // About to replace the saved version (#902). If a crash came after it
      // was saved but before its announcement was recorded, record that
      // announcement now, keyed by its own exact version; already recorded,
      // this is a no-op. A changed source never displaces an earlier version.
      deps.operations.reconcileCompleted(
        announceKey(existing),
        { ref: existing },
        [announcement(saved.data, existing, deps.now)],
      );
    }
  }
  const bytes = serialise(CollectionRecordSchema.parse(record));
  const ref = await deps.artifacts.revise(
    path,
    bytes,
    existing?.sha256 ?? null,
  );
  const unchanged = existing?.sha256 === sha256(bytes);

  // Record the announcement durably, then publish it.
  const event = announcement(record, ref, deps.now);
  deps.operations.reconcileCompleted(announceKey(ref), { ref }, [event]);
  await dispatchPendingSources(deps, item);
  return {
    status: unchanged ? "unchanged" : "saved",
    ref,
    eventId: event.eventId,
    announced: deps.operations.pendingEventStatus(event.eventId) === "sent",
    preview,
    imagesFailed,
  };
}

/**
 * Resend the source-ready event for what is saved now, without fetching. The
 * saved file and so the event's logical identity are those of the last
 * capture; the consumer deduplicates it. Regenerating an article is a
 * separate, explicit request.
 */
export async function resendSource(
  item: Pick<SubstackItem, "publicationId" | "postId">,
  deps: Pick<SourceCaptureDeps, "artifacts" | "publisher" | "now">,
): Promise<
  | { status: "resent"; ref: ArtifactRef; eventId: string }
  | { status: "not-saved" }
> {
  const ref = await deps.artifacts.lookup(sourcePath(item));
  if (!ref) return { status: "not-saved" };
  const record = CollectionRecordSchema.parse(
    JSON.parse(await deps.artifacts.read(ref)),
  );
  const event = announcement(record, ref, deps.now);
  await deps.publisher.publish(event.subject, encoder.encode(event.payload), {
    msgId: event.eventId,
  });
  return { status: "resent", ref, eventId: event.eventId };
}
