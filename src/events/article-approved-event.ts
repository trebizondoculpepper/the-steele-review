import { postCorrelationId } from "../observability/post-correlation.js";
import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";

/**
 * Approved article (#262): one durable event per approved article revision,
 * consumed independently by every configured destination. It carries only
 * immutable references; consumers read the approved content from the
 * artifact store and re-check the approval against those exact bytes.
 */

export const ARTICLE_APPROVED_EVENT_TYPE_V1 = "org.steele.article.approved.v1";
export const ARTICLE_APPROVED_DATASCHEMA_V1 = "urn:steele:schema:article-approved:v1";
export const ARTICLE_APPROVED_SUBJECT = "steele.v1.article.approved";
export const PUBLICATION_STREAM = "STEELE_PUBLICATION";
const SOURCE = "urn:steele:publishing:approval";

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/);

export const ArticleApprovedDataSchema = z
  .object({
    publicationId: Id,
    postId: Id,
    /** The exact approved draft (Markdown) revision. */
    draft: ArtifactReferenceSchema,
    /** The verification report that approved exactly that draft. */
    approval: ArtifactReferenceSchema,
    /** The evidence package the draft was written from. */
    package: ArtifactReferenceSchema,
    approvedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ArticleApprovedData = z.infer<typeof ArticleApprovedDataSchema>;

export function createArticleApprovedEvent(
  data: ArticleApprovedData,
  id: string,
): CloudEvent<ArticleApprovedData> {
  const valid = ArticleApprovedDataSchema.parse(data);
  return new CloudEvent<ArticleApprovedData>(
    {
      specversion: "1.0",
      id,
      source: SOURCE,
      type: ARTICLE_APPROVED_EVENT_TYPE_V1,
      time: valid.approvedAt,
      subject: `article/${valid.publicationId}/${valid.postId}`,
      correlationid: postCorrelationId(valid),
      datacontenttype: "application/json",
      dataschema: ARTICLE_APPROVED_DATASCHEMA_V1,
      data: valid,
    },
    true,
  );
}

const EnvelopeSchema = z.looseObject({
  specversion: z.literal("1.0"),
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(500),
  type: z.literal(ARTICLE_APPROVED_EVENT_TYPE_V1),
  dataschema: z.literal(ARTICLE_APPROVED_DATASCHEMA_V1),
  datacontenttype: z.literal("application/json"),
  subject: z.string().min(1),
});

export function parseArticleApprovedEvent(
  input: string,
): ArticleApprovedData & { eventId: string } {
  const envelope = EnvelopeSchema.parse(JSON.parse(input));
  const data = ArticleApprovedDataSchema.parse(envelope.data);
  if (envelope.subject !== `article/${data.publicationId}/${data.postId}`) {
    throw new Error("subject does not match the article");
  }
  return { eventId: envelope.id, ...data };
}

export function articleApprovedDataJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ArticleApprovedDataSchema) as Record<string, unknown>;
}
