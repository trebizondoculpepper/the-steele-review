import { randomUUID } from "node:crypto";
import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import { IngestionReasonSchema } from "./discovery-event.js";

/**
 * Text-ready event: retained text for one post is durably committed to the
 * archive and can be indexed. It references the exact committed artifact and
 * carries the ingestion reason through, so backfill provenance survives.
 * Metadata only: no text, media or private configuration.
 */

export const TEXT_READY_EVENT_TYPE_V1 = "org.steele.content.extracted.v1";
export const TEXT_READY_DATASCHEMA_V1 = "urn:steele:schema:content-extracted:v1";
export const TEXT_READY_SUBJECT = "steele.v1.content.extracted";
export const DEFAULT_COLLECTOR_SOURCE = "urn:steele:collector:substack";

export const TextReadyDataSchema = z
  .object({
    publicationId: z.string().min(1),
    postId: z.string().min(1),
    url: z.url({ protocol: /^https$/ }),
    ingestionReason: IngestionReasonSchema,
    artifact: ArtifactReferenceSchema,
    acquisitionMethod: z.string().min(1).max(100),
    complete: z.boolean().describe("False when only part of the content could be retained."),
  })
  .strict();
export type TextReadyData = z.infer<typeof TextReadyDataSchema>;

export function createTextReadyEvent(
  data: TextReadyData,
  options: { causationId?: string; correlationId?: string } = {},
  deps: { newId: () => string; now: () => Date } = { newId: randomUUID, now: () => new Date() },
): CloudEvent<TextReadyData> {
  const valid = TextReadyDataSchema.parse(data);
  return new CloudEvent<TextReadyData>(
    {
      specversion: "1.0",
      id: deps.newId(),
      source: DEFAULT_COLLECTOR_SOURCE,
      type: TEXT_READY_EVENT_TYPE_V1,
      time: deps.now().toISOString(),
      subject: `substack/${valid.publicationId}/${valid.postId}`,
      datacontenttype: "application/json",
      dataschema: TEXT_READY_DATASCHEMA_V1,
      data: valid,
      ...(options.causationId ? { causationid: options.causationId } : {}),
      ...(options.correlationId ? { correlationid: options.correlationId } : {}),
    },
    true,
  );
}

/** Decode and validate a received text-ready event. */
export function parseTextReadyEvent(input: string): CloudEvent<TextReadyData> {
  const raw = JSON.parse(input) as Record<string, unknown>;
  if (raw.type !== TEXT_READY_EVENT_TYPE_V1 || raw.dataschema !== TEXT_READY_DATASCHEMA_V1) {
    throw new Error("unsupported text-ready event");
  }
  if (typeof raw.id !== "string" || typeof raw.time !== "string") {
    throw new Error("malformed text-ready envelope");
  }
  const data = TextReadyDataSchema.parse(raw.data);
  return new CloudEvent<TextReadyData>({ ...raw, data }, true);
}
