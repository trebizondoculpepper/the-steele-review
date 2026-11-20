import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { AssertionKindSchema } from "../analysis/grounded-claims.js";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";

/**
 * One extracted claim occurrence (#179): an accepted claim from one saved
 * analysis of one post and source version. The same claim repeated in a later
 * post is a new occurrence identified by its passage, so research dedup uses
 * the stable claim identity plus evidence/input versions, never an event count.
 *
 * Minimal context only: exact artifact pointers, the occurrence identity, the
 * stable claim identity and the linked theme proposal IDs. No source prose and
 * no model calls.
 */

export const CLAIM_OCCURRED_EVENT_TYPE_V1 = "org.steele.claim.occurred.v1";
export const CLAIM_OCCURRED_DATASCHEMA_V1 = "urn:steele:schema:claim-occurred:v1";
export const CLAIM_OCCURRED_SUBJECT = "steele.v1.claim.occurred";
export const DEFAULT_CLAIM_OCCURRENCE_SOURCE = "urn:steele:analysis:fan-out";

export const ClaimOccurredDataSchema = z
  .object({
    publicationId: z.string().min(1),
    postId: z.string().min(1),
    sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    sourceArtifact: ArtifactReferenceSchema,
    themeResult: ArtifactReferenceSchema,
    claimResult: ArtifactReferenceSchema,
    /**
     * Stable identity of this occurrence (post, source version and span), so a
     * repeated claim in another post is a distinct occurrence of one claim.
     */
    occurrenceId: z.string().min(1).max(200),
    /** Stable claim identity this occurrence belongs to; absent for questions. */
    claimId: z.string().regex(/^claim-[0-9a-f]{32}$/).optional(),
    kind: AssertionKindSchema,
    /** Result-local theme proposal IDs linked to this claim. */
    themeIds: z.array(z.string()).max(100),
  })
  .strict();
export type ClaimOccurredData = z.infer<typeof ClaimOccurredDataSchema>;

/** JSON Schema (draft 2020-12) for {@link ClaimOccurredDataSchema}. */
export function claimOccurredDataJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ClaimOccurredDataSchema) as Record<string, unknown>;
}

export function createClaimOccurredEvent(
  data: ClaimOccurredData,
  deps: { id: string; now: () => Date; causationId?: string },
): CloudEvent<ClaimOccurredData> {
  const valid = ClaimOccurredDataSchema.parse(data);
  return new CloudEvent<ClaimOccurredData>(
    {
      specversion: "1.0",
      id: deps.id,
      source: DEFAULT_CLAIM_OCCURRENCE_SOURCE,
      type: CLAIM_OCCURRED_EVENT_TYPE_V1,
      time: deps.now().toISOString(),
      subject: `substack/${valid.publicationId}/${valid.postId}`,
      datacontenttype: "application/json",
      dataschema: CLAIM_OCCURRED_DATASCHEMA_V1,
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
  type: z.literal(CLAIM_OCCURRED_EVENT_TYPE_V1),
  dataschema: z.literal(CLAIM_OCCURRED_DATASCHEMA_V1),
  datacontenttype: z.literal("application/json"),
  time: z.iso.datetime({ offset: true }),
  subject: z.string().min(1),
  causationid: z.string().min(1).max(200).optional(),
});

/** Validate a received claim-occurrence event; throws on anything malformed. */
export function parseClaimOccurredEvent(input: string): ClaimOccurredData {
  const envelope = EnvelopeSchema.parse(JSON.parse(input));
  const data = ClaimOccurredDataSchema.parse(envelope.data);
  if (envelope.subject !== `substack/${data.publicationId}/${data.postId}`) {
    throw new Error("subject does not match payload");
  }
  return data;
}
