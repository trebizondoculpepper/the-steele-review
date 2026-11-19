import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";

/**
 * One post-analysed completion event (#178): emitted once per input post and
 * analysis version, after both the theme-proposal result and the linked
 * claim-extraction result are durably saved. It points at the exact saved
 * artifacts; it announces validated stage completion, not perfect semantic
 * quality, and does not imply proposals were mapped to canonical themes.
 */

export const POST_ANALYSED_EVENT_TYPE_V1 = "org.steele.post.analysed.v1";
export const POST_ANALYSED_DATASCHEMA_V1 = "urn:steele:schema:post-analysed:v1";
export const POST_ANALYSED_SUBJECT = "steele.v1.post.analysed";
export const ANALYSIS_STREAM = "STEELE_ANALYSIS";
export const DEFAULT_ANALYSIS_SOURCE = "urn:steele:analysis:extraction";

const Versions = z.object({ model: z.string().min(1), prompt: z.string().min(1) }).strict();

export const PostAnalysedDataSchema = z
  .object({
    publicationId: z.string().min(1),
    postId: z.string().min(1),
    sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    sourceArtifact: ArtifactReferenceSchema,
    themeResult: ArtifactReferenceSchema,
    claimResult: ArtifactReferenceSchema,
    themes: Versions.extend({ schema: z.number().int() }).strict(),
    claims: Versions.extend({ schema: z.number().int() }).strict(),
    counts: z
      .object({
        themeProposals: z.number().int().min(0),
        acceptedClaims: z.number().int().min(0),
        candidates: z.number().int().min(0),
        rejected: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type PostAnalysedData = z.infer<typeof PostAnalysedDataSchema>;

export function createPostAnalysedEvent(
  data: PostAnalysedData,
  deps: { id: string; now: () => Date },
): CloudEvent<PostAnalysedData> {
  const valid = PostAnalysedDataSchema.parse(data);
  return new CloudEvent<PostAnalysedData>(
    {
      specversion: "1.0",
      id: deps.id,
      source: DEFAULT_ANALYSIS_SOURCE,
      type: POST_ANALYSED_EVENT_TYPE_V1,
      time: deps.now().toISOString(),
      subject: `substack/${valid.publicationId}/${valid.postId}`,
      datacontenttype: "application/json",
      dataschema: POST_ANALYSED_DATASCHEMA_V1,
      data: valid,
    },
    true,
  );
}

const EnvelopeSchema = z.looseObject({
  specversion: z.literal("1.0"),
  id: z.string().min(1).max(200),
  type: z.literal(POST_ANALYSED_EVENT_TYPE_V1),
  dataschema: z.literal(POST_ANALYSED_DATASCHEMA_V1),
  subject: z.string().min(1),
});

/** Validate a received post-analysed event; throws on anything malformed. */
export function parsePostAnalysedEvent(input: string): PostAnalysedData {
  const envelope = EnvelopeSchema.parse(JSON.parse(input));
  const data = PostAnalysedDataSchema.parse(envelope.data);
  if (envelope.subject !== `substack/${data.publicationId}/${data.postId}`) {
    throw new Error("subject does not match payload");
  }
  return data;
}
