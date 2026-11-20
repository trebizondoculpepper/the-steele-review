import { CloudEvent } from "cloudevents";
import { z } from "zod";

/**
 * Research index reconciliation request (#232): ask the research index worker
 * to reconcile one configured route from its durable checkpoint. The request
 * names a route only; repository paths and index targets are resolved from
 * the worker's trusted configuration, never from the message.
 */

export const RESEARCH_REINDEX_EVENT_TYPE_V1 = "org.steele.research.reindex.requested.v1";
export const RESEARCH_REINDEX_DATASCHEMA_V1 = "urn:steele:schema:research-reindex-requested:v1";
export const RESEARCH_REINDEX_SUBJECT = "steele.v1.research.reindex.requested";
export const DEFAULT_RESEARCH_REINDEX_SOURCE = "urn:steele:research:reindex";

export const RouteName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const ResearchReindexDataSchema = z.object({ route: RouteName }).strict();
export type ResearchReindexData = z.infer<typeof ResearchReindexDataSchema>;

export function createResearchReindexEvent(
  data: ResearchReindexData,
  deps: { id: string; now: () => Date },
): CloudEvent<ResearchReindexData> {
  const valid = ResearchReindexDataSchema.parse(data);
  return new CloudEvent<ResearchReindexData>(
    {
      specversion: "1.0",
      id: deps.id,
      source: DEFAULT_RESEARCH_REINDEX_SOURCE,
      type: RESEARCH_REINDEX_EVENT_TYPE_V1,
      time: deps.now().toISOString(),
      subject: `route/${valid.route}`,
      datacontenttype: "application/json",
      dataschema: RESEARCH_REINDEX_DATASCHEMA_V1,
      data: valid,
    },
    true,
  );
}

const EnvelopeSchema = z.looseObject({
  specversion: z.literal("1.0"),
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(500),
  type: z.literal(RESEARCH_REINDEX_EVENT_TYPE_V1),
  time: z.iso.datetime({ offset: true }).optional(),
  subject: z.string().min(1).max(200).optional(),
  dataschema: z.literal(RESEARCH_REINDEX_DATASCHEMA_V1),
  datacontenttype: z.literal("application/json"),
});

/** Parse a delivered request; throws on anything that is not a valid v1 request. */
export function parseResearchReindexEvent(input: string): ResearchReindexData & { id: string } {
  const envelope = EnvelopeSchema.parse(JSON.parse(input));
  return { id: envelope.id, ...ResearchReindexDataSchema.parse(envelope.data) };
}

export function researchReindexDataJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ResearchReindexDataSchema) as Record<string, unknown>;
}
