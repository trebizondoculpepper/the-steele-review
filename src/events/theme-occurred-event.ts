import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";

/**
 * One detected theme occurrence (#179): a theme proposed by one saved analysis
 * of one post and source version. A repeated theme in a later post is a new
 * occurrence of the same topic, so the librarian can organise dossiers and
 * the researcher can deduplicate on the stable identity plus input versions,
 * never on an event count.
 *
 * Minimal context only: exact artifact pointers, the result-local theme ID and
 * its display title. No model calls and no source prose.
 */

export const THEME_OCCURRED_EVENT_TYPE_V1 = "org.steele.theme.occurred.v1";
export const THEME_OCCURRED_DATASCHEMA_V1 = "urn:steele:schema:theme-occurred:v1";
export const THEME_OCCURRED_SUBJECT = "steele.v1.theme.occurred";
export const DEFAULT_THEME_OCCURRENCE_SOURCE = "urn:steele:analysis:fan-out";

export const ThemeOccurredDataSchema = z
  .object({
    publicationId: z.string().min(1),
    postId: z.string().min(1),
    sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    sourceArtifact: ArtifactReferenceSchema,
    themeResult: ArtifactReferenceSchema,
    claimResult: ArtifactReferenceSchema,
    /** Stable identity of this occurrence: the saved result plus the proposal ID. */
    occurrenceId: z.string().min(1).max(200),
    theme: z
      .object({
        id: z.string().regex(/^theme-[0-9a-f]{24}$/),
        title: z.string().min(1).max(200),
        description: z.string().min(1).max(2000).optional(),
      })
      .strict(),
  })
  .strict();
export type ThemeOccurredData = z.infer<typeof ThemeOccurredDataSchema>;

/** JSON Schema (draft 2020-12) for {@link ThemeOccurredDataSchema}. */
export function themeOccurredDataJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ThemeOccurredDataSchema) as Record<string, unknown>;
}

export function createThemeOccurredEvent(
  data: ThemeOccurredData,
  deps: { id: string; now: () => Date; causationId?: string },
): CloudEvent<ThemeOccurredData> {
  const valid = ThemeOccurredDataSchema.parse(data);
  return new CloudEvent<ThemeOccurredData>(
    {
      specversion: "1.0",
      id: deps.id,
      source: DEFAULT_THEME_OCCURRENCE_SOURCE,
      type: THEME_OCCURRED_EVENT_TYPE_V1,
      time: deps.now().toISOString(),
      subject: `substack/${valid.publicationId}/${valid.postId}`,
      datacontenttype: "application/json",
      dataschema: THEME_OCCURRED_DATASCHEMA_V1,
      ...(deps.causationId ? { causationid: deps.causationId } : {}),
      data: valid,
    },
    true,
  );
}

const EnvelopeSchema = z.looseObject({
  specversion: z.literal("1.0"),
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(500),
  type: z.literal(THEME_OCCURRED_EVENT_TYPE_V1),
  dataschema: z.literal(THEME_OCCURRED_DATASCHEMA_V1),
  datacontenttype: z.literal("application/json"),
  time: z.iso.datetime({ offset: true }),
  subject: z.string().min(1),
  causationid: z.string().min(1).max(200).optional(),
});

/** Validate a received theme-occurrence event; throws on anything malformed. */
export function parseThemeOccurredEvent(input: string): ThemeOccurredData {
  const envelope = EnvelopeSchema.parse(JSON.parse(input));
  const data = ThemeOccurredDataSchema.parse(envelope.data);
  if (envelope.subject !== `substack/${data.publicationId}/${data.postId}`) {
    throw new Error("subject does not match payload");
  }
  if (data.occurrenceId.length === 0) throw new Error("occurrence identity missing");
  return data;
}
