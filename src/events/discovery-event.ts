import { postCorrelationId } from "../observability/post-correlation.js";
import { randomUUID } from "node:crypto";
import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { SubstackItemSchema, type SubstackItem } from "../content/substack-item.js";

/**
 * Discovery event: a CloudEvents 1.0 structured JSON event announcing that a
 * public Substack post was discovered. Event identity (`source` + `id`) is
 * separate from content identity (`publicationId` + `postId`, carried in
 * `subject` and `data`). A retry must resend the same constructed event; a new
 * discovery of the same post creates a new event with the same content key.
 */

export const DISCOVERY_EVENT_TYPE_V1 = "org.steele.source.detected.v1";
export const DISCOVERY_DATASCHEMA_V1 = "urn:steele:schema:source-detected:v1";
export const DEFAULT_DISCOVERY_SOURCE = "urn:steele:discovery:substack";
export const SUPPORTED_DISCOVERY_EVENT_TYPES: ReadonlySet<string> = new Set([
  DISCOVERY_EVENT_TYPE_V1,
]);

export const IngestionReasonSchema = z
  .enum(["live", "backfill", "reprocess"])
  .describe("Why the post was discovered: live polling, bounded backfill or reprocessing.");
export type IngestionReason = z.infer<typeof IngestionReasonSchema>;

export const DiscoveryEventDataSchema = SubstackItemSchema.extend({
  ingestionReason: IngestionReasonSchema,
  /**
   * Set only for a deliberate single-item reingestion (#558): the stable
   * request identity the collector runs it under. Ordinary discovery omits it.
   */
  reingestRequestId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
    .optional()
    .describe("Stable request ID of a deliberate single-item reingestion; absent for discovery."),
}).meta({
  title: "SourceDetectedV1",
  description:
    "Payload of a discovery event: normalised public post metadata plus the ingestion reason.",
});
export type DiscoveryEventData = z.infer<typeof DiscoveryEventDataSchema>;

/** Optional CloudEvents extension attributes for tracing. */
const ExtensionSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

export interface DiscoveryEventOptions {
  reason: IngestionReason;
  /** Discovery-run correlation ID (`correlationid` extension). */
  correlationId?: string;
  /** ID of the event or command that caused this one (`causationid` extension). */
  causationId?: string;
  /** Stable logical producer URI; must not name a private host. */
  source?: string;
  /** Deliberate single-item reingestion request (#558). */
  reingestRequestId?: string;
}

export interface DiscoveryEventDeps {
  newId: () => string;
  now: () => Date;
}

const defaultDeps: DiscoveryEventDeps = { newId: randomUUID, now: () => new Date() };

export type DiscoveryEvent = CloudEvent<DiscoveryEventData>;

/** Stable logical content key used as the CloudEvents `subject`. */
export function contentSubject(item: Pick<SubstackItem, "publicationId" | "postId">): string {
  return `substack/${item.publicationId}/${item.postId}`;
}

/**
 * Build and validate a discovery event for one item. Inject `deps` for
 * deterministic IDs and times in tests. Throws if the item, options or
 * resulting envelope are invalid.
 */
export function createDiscoveryEvent(
  item: SubstackItem,
  options: DiscoveryEventOptions,
  deps: DiscoveryEventDeps = defaultDeps,
): DiscoveryEvent {
  const data = DiscoveryEventDataSchema.parse({
    ...SubstackItemSchema.parse(item),
    ingestionReason: options.reason,
    ...(options.reingestRequestId ? { reingestRequestId: options.reingestRequestId } : {}),
  });
  const extensions: Record<string, string> = { postcorrelationid: postCorrelationId(data) };
  if (options.correlationId !== undefined) {
    extensions.correlationid = ExtensionSchema.parse(options.correlationId);
  }
  if (options.causationId !== undefined) {
    extensions.causationid = ExtensionSchema.parse(options.causationId);
  }
  const event = new CloudEvent<DiscoveryEventData>(
    {
      specversion: "1.0",
      id: deps.newId(),
      source: z.url().parse(options.source ?? DEFAULT_DISCOVERY_SOURCE),
      type: DISCOVERY_EVENT_TYPE_V1,
      time: deps.now().toISOString(),
      subject: contentSubject(data),
      datacontenttype: "application/json",
      dataschema: DISCOVERY_DATASCHEMA_V1,
      data,
      ...extensions,
    },
    true,
  );
  return event;
}

/** Serialise a validated event as structured-mode JSON (UTF-8 text). */
export function serializeDiscoveryEvent(event: DiscoveryEvent): string {
  return JSON.stringify(event.toJSON());
}

export class InvalidDiscoveryEventError extends Error {
  constructor(reason: string) {
    super(`Invalid discovery event: ${reason}`);
    this.name = "InvalidDiscoveryEventError";
  }
}

/**
 * Decode and validate a structured JSON discovery event received from
 * transport. Rejects malformed envelopes, unsupported types/schema versions
 * and invalid payloads. Error messages never include the raw payload.
 */
export function parseDiscoveryEvent(input: string | Record<string, unknown>): DiscoveryEvent {
  let raw: unknown;
  try {
    raw = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new InvalidDiscoveryEventError("not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidDiscoveryEventError("not a JSON object");
  }
  const record = raw as Record<string, unknown>;
  // The SDK fills in a missing id/time rather than rejecting, so require them here.
  const envelope = z
    .object({
      id: z.string().min(1),
      source: z.string().min(1),
      time: z.iso.datetime({ offset: true }),
      subject: z.string().min(1),
    })
    .safeParse(record);
  if (!envelope.success) {
    throw new InvalidDiscoveryEventError("missing or malformed envelope attribute");
  }
  if (record.specversion !== "1.0") {
    throw new InvalidDiscoveryEventError("unsupported specversion");
  }
  if (typeof record.type !== "string" || !SUPPORTED_DISCOVERY_EVENT_TYPES.has(record.type)) {
    throw new InvalidDiscoveryEventError("unsupported event type");
  }
  if (record.dataschema !== DISCOVERY_DATASCHEMA_V1) {
    throw new InvalidDiscoveryEventError("unsupported dataschema");
  }
  if (record.datacontenttype !== "application/json") {
    throw new InvalidDiscoveryEventError("unsupported datacontenttype");
  }
  const data = DiscoveryEventDataSchema.safeParse(record.data);
  if (!data.success) {
    throw new InvalidDiscoveryEventError("payload failed validation");
  }
  if (record.subject !== contentSubject(data.data)) {
    throw new InvalidDiscoveryEventError("subject does not match payload content key");
  }
  for (const key of ["correlationid", "causationid"]) {
    if (record[key] !== undefined && !ExtensionSchema.safeParse(record[key]).success) {
      throw new InvalidDiscoveryEventError(`invalid ${key}`);
    }
  }
  try {
    return new CloudEvent<DiscoveryEventData>({ ...record, data: data.data }, true);
  } catch {
    throw new InvalidDiscoveryEventError("envelope failed CloudEvents validation");
  }
}

/** JSON Schema (draft 2020-12) for the discovery payload, from the Zod definition. */
export function discoveryEventDataJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(DiscoveryEventDataSchema) as Record<string, unknown>;
}

export interface FieldDictionaryEntry {
  field: string;
  required: boolean;
  description: string;
}

/** Field dictionary derived from the same Zod definition as validation. */
export function discoveryEventFieldDictionary(): FieldDictionaryEntry[] {
  const schema = discoveryEventDataJsonSchema() as {
    properties: Record<string, { description?: string }>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([field, prop]) => ({
    field,
    required: required.has(field),
    description: prop.description ?? "",
  }));
}
