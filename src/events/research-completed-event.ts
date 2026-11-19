import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";

/**
 * Research job completion (#215): job ID, terminal outcome and the exact
 * manifest version when a report exists. Lightweight by design; consumers
 * read the saved result and manifest by reference.
 */

export const RESEARCH_COMPLETED_EVENT_TYPE_V1 = "org.steele.research.completed.v1";
export const RESEARCH_COMPLETED_DATASCHEMA_V1 = "urn:steele:schema:research-completed:v1";
export const RESEARCH_COMPLETED_SUBJECT = "steele.v1.research.completed";
export const RESEARCH_STREAM = "STEELE_RESEARCH";
export const DEFAULT_RESEARCH_SOURCE = "urn:steele:research:jobs";

export const ResearchCompletedDataSchema = z
  .object({
    jobId: z.string().regex(/^research-[0-9a-f]{32}$/),
    outcome: z.enum(["complete", "complete-with-gaps", "failed"]),
    manifest: ArtifactReferenceSchema.optional(),
  })
  .strict();
export type ResearchCompletedData = z.infer<typeof ResearchCompletedDataSchema>;

export function createResearchCompletedEvent(
  data: ResearchCompletedData,
  deps: { id: string; now: () => Date },
): CloudEvent<ResearchCompletedData> {
  const valid = ResearchCompletedDataSchema.parse(data);
  return new CloudEvent<ResearchCompletedData>(
    {
      specversion: "1.0",
      id: deps.id,
      source: DEFAULT_RESEARCH_SOURCE,
      type: RESEARCH_COMPLETED_EVENT_TYPE_V1,
      time: deps.now().toISOString(),
      subject: `research/${valid.jobId}`,
      datacontenttype: "application/json",
      dataschema: RESEARCH_COMPLETED_DATASCHEMA_V1,
      data: valid,
    },
    true,
  );
}

const EnvelopeSchema = z.looseObject({
  specversion: z.literal("1.0"),
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(500),
  type: z.literal(RESEARCH_COMPLETED_EVENT_TYPE_V1),
  time: z.iso.datetime({ offset: true }),
  datacontenttype: z.literal("application/json"),
  dataschema: z.literal(RESEARCH_COMPLETED_DATASCHEMA_V1),
  subject: z.string().min(1),
});

export function parseResearchCompletedEvent(input: string): ResearchCompletedData {
  const envelope = EnvelopeSchema.parse(JSON.parse(input));
  const data = ResearchCompletedDataSchema.parse(envelope.data);
  if (envelope.subject !== `research/${data.jobId}`) throw new Error("subject does not match job");
  return data;
}

/** JSON Schema for the payload, from the same Zod definition. */
export function researchCompletedDataJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ResearchCompletedDataSchema) as Record<string, unknown>;
}
