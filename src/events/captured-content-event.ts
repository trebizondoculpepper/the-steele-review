import { articleRunTarget } from "../content/article-run-target.js";
import { postCorrelationId } from "../observability/post-correlation.js";
import { createHash } from "node:crypto";
import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";

/**
 * Captured content (#269): the source-neutral inbound contract for the
 * writing engine. Any ingestion source (Substack, a blog, an RSS feed, a
 * manual import) emits one event per archived item revision, pointing at the
 * exact Git artifact holding its text. The NATS-to-Restate bridge (#270)
 * consumes it; the existing text-ready event (`steele.v1.content.extracted`,
 * Substack-specific) is unchanged and still drives indexing.
 *
 * Identity: `source.namespace` (for example `substack/saveusnow`) plus a
 * stable `itemId` within it names the item; the archived artifact and its
 * `sourceVersion` name the exact text revision. The event ID is derived from
 * those, so redelivering or re-emitting the same revision is idempotent.
 */

export const CAPTURED_CONTENT_EVENT_TYPE_V1 = "org.steele.content.captured.v1";
export const CAPTURED_CONTENT_DATASCHEMA_V1 = "urn:steele:schema:content-captured:v1";
export const CAPTURED_CONTENT_SUBJECT = "steele.v1.content.captured";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);

export const TranscriptProvenanceSchema = z.discriminatedUnion("kind", [
  /** Text needed no transcript (an article). */
  z.object({ kind: z.literal("none") }).strict(),
  /** Transcript supplied by the source platform. */
  z.object({ kind: z.literal("supplied"), variant: z.string().max(100).optional() }).strict(),
  /** Transcript produced by us (local or hosted transcription). */
  z.object({ kind: z.literal("generated"), engine: z.string().min(1).max(200) }).strict(),
]);
export type TranscriptProvenance = z.infer<typeof TranscriptProvenanceSchema>;

export const CapturedContentDataSchema = z
  .object({
    source: z
      .object({
        /** `<kind>/<instance>`, e.g. `substack/saveusnow`. */
        namespace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}\/[a-z0-9][a-z0-9-]{0,99}$/),
        kind: Slug,
      })
      .strict(),
    /** Stable item identity within the namespace (e.g. a Substack post slug). */
    itemId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/),
    originalUrl: z.url({ protocol: /^https$/ }),
    title: z.string().max(500).optional(),
    publishedAt: z.iso.datetime({ offset: true }).optional(),
    /** Exact archived text revision. */
    artifact: ArtifactReferenceSchema,
    sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    complete: z.boolean(),
    transcript: TranscriptProvenanceSchema,
    ingestionReason: z.enum(["live", "backfill", "reprocess"]),
  })
  .strict()
  .refine(
    (d) => d.source.namespace.startsWith(`${d.source.kind}/`),
    "namespace must start with its kind",
  );
export type CapturedContentData = z.infer<typeof CapturedContentDataSchema>;

/** Stable event ID for one item revision. */
export function capturedContentEventId(
  data: Pick<CapturedContentData, "source" | "itemId" | "artifact">,
): string {
  return `captured-${createHash("sha256")
    .update(
      JSON.stringify([data.source.namespace, data.itemId, data.artifact.hash, data.artifact.path]),
    )
    .digest("hex")
    .slice(0, 32)}`;
}

export function createCapturedContentEvent(
  data: CapturedContentData,
  now: () => Date = () => new Date(),
) {
  const valid = CapturedContentDataSchema.parse(data);
  return new CloudEvent<CapturedContentData>(
    {
      specversion: "1.0",
      id: capturedContentEventId(valid),
      source: `urn:steele:capture:${valid.source.namespace}`,
      type: CAPTURED_CONTENT_EVENT_TYPE_V1,
      time: now().toISOString(),
      subject: `${valid.source.namespace}/${valid.itemId}`,
      correlationid: postCorrelationId(articleRunTarget(valid.source.namespace, valid.itemId)),
      datacontenttype: "application/json",
      dataschema: CAPTURED_CONTENT_DATASCHEMA_V1,
      data: valid,
    },
    true,
  );
}

const EnvelopeSchema = z.looseObject({
  specversion: z.literal("1.0"),
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(500),
  type: z.literal(CAPTURED_CONTENT_EVENT_TYPE_V1),
  dataschema: z.literal(CAPTURED_CONTENT_DATASCHEMA_V1),
  datacontenttype: z.literal("application/json"),
  time: z.iso.datetime({ offset: true }),
  subject: z.string().min(1),
});

export function parseCapturedContentEvent(
  input: string,
): CapturedContentData & { eventId: string } {
  const envelope = EnvelopeSchema.parse(JSON.parse(input));
  const data = CapturedContentDataSchema.parse(envelope.data);
  if (envelope.subject !== `${data.source.namespace}/${data.itemId}`)
    throw new Error("subject does not match the item");
  return { eventId: envelope.id, ...data };
}

export function capturedContentDataJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(CapturedContentDataSchema, { unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
}

/** Substack adapter: the captured-content data for one archived Substack post. */
export function substackCapturedContent(input: {
  artifact: ArtifactReference;
  record: {
    item: {
      publicationId: string;
      postId: string;
      url: string;
      title?: string;
      publishedAt?: string;
    };
    ingestionReason: "live" | "backfill" | "reprocess";
    complete: boolean;
    provenance: { method: string; transcriptVariant?: unknown };
  };
  sourceVersion: string;
}): CapturedContentData {
  const { record } = input;
  const variant =
    typeof record.provenance.transcriptVariant === "string"
      ? record.provenance.transcriptVariant
      : undefined;
  // The collector records its own audio transcription as "machine-transcript";
  // anything else naming a transcript is the platform's supplied transcript.
  const method = record.provenance.method;
  const transcript: TranscriptProvenance =
    method === "machine-transcript" || /whisper|hosted-transcri|local-transcri/i.test(method)
      ? { kind: "generated", engine: method }
      : /transcri/i.test(method) || variant
        ? { kind: "supplied", ...(variant ? { variant } : {}) }
        : { kind: "none" };
  return CapturedContentDataSchema.parse({
    source: { namespace: `substack/${record.item.publicationId}`, kind: "substack" },
    itemId: record.item.postId,
    originalUrl: record.item.url,
    ...(record.item.title ? { title: record.item.title.slice(0, 500) } : {}),
    ...(record.item.publishedAt ? { publishedAt: record.item.publishedAt } : {}),
    artifact: input.artifact,
    sourceVersion: input.sourceVersion,
    complete: record.complete,
    transcript,
    ingestionReason: record.ingestionReason,
  });
}
