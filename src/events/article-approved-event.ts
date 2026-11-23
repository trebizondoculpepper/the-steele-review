import { postCorrelationId } from "../observability/post-correlation.js";
import { CloudEvent } from "cloudevents";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import {
  DraftTargetSchema,
  OwnerDraftTargetsSchema,
} from "../content/owner-draft-authorization.js";

/**
 * Approved article (#262): one durable event per approved article revision,
 * consumed independently by every configured destination. It carries only
 * immutable references; consumers read the approved content from the
 * artifact store and re-check the approval against those exact bytes.
 */

export const ARTICLE_APPROVED_EVENT_TYPE_V1 = "org.steele.article.approved.v1";
export const ARTICLE_APPROVED_DATASCHEMA_V1 = "urn:steele:schema:article-approved:v1";
export const ARTICLE_DRAFT_AUTHORIZED_EVENT_TYPE_V2 = "org.steele.article.draft-authorized.v2";
export const ARTICLE_DRAFT_AUTHORIZED_DATASCHEMA_V2 =
  "urn:steele:schema:article-draft-authorized:v2";
export const ARTICLE_APPROVED_SUBJECT = "steele.v1.article.approved";
export const PUBLICATION_STREAM = "STEELE_PUBLICATION";
const SOURCE = "urn:steele:publishing:approval";

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/);

const CommonDataSchema = z
  .object({
    publicationId: Id,
    postId: Id,
    /** The exact approved draft (Markdown) revision. */
    draft: ArtifactReferenceSchema,
    /** The verification report that approved exactly that draft. */
    approval: ArtifactReferenceSchema,
    /** Absent only on legacy combined-verifier events. */
    approvalKind: z
      .enum([
        "combined-verification",
        "editorial-judgment",
        "owner-draft-rehearsal",
        "editorial-cycle-complete",
      ])
      .optional(),
    /**
     * Completed-cycle releases only (#820): the judge's actual final decision,
     * so a release after a "revise" is never presented as an approval.
     */
    judgmentDecision: z.enum(["approve", "revise"]).optional(),
    authorizationOutcome: z.literal("owner-authorized-draft").optional(),
    draftTargets: z.array(DraftTargetSchema).length(3).optional(),
    /** Actual assessor record, never a fabricated combined verification report. */
    assessment: ArtifactReferenceSchema.optional(),
    /** Present for payload-aware verification; absent only for legacy body-only approvals. */
    publication: ArtifactReferenceSchema.optional(),
    /** The evidence package the draft was written from. */
    package: ArtifactReferenceSchema,
    approvedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
/** Legacy data schema and emitted bytes remain unchanged. */
export const ArticleApprovedDataV1Schema = CommonDataSchema.omit({
  authorizationOutcome: true,
  draftTargets: true,
}).extend({
  approvalKind: z
    .enum(["combined-verification", "editorial-judgment", "editorial-cycle-complete"])
    .optional(),
});
export const ArticleOwnerDraftDataV2Schema = CommonDataSchema.omit({
  judgmentDecision: true,
}).extend({
  approvalKind: z.literal("owner-draft-rehearsal"),
  authorizationOutcome: z.literal("owner-authorized-draft"),
  draftTargets: OwnerDraftTargetsSchema,
  publication: ArtifactReferenceSchema,
  assessment: ArtifactReferenceSchema,
});
export const ArticleApprovedDataSchema = CommonDataSchema.superRefine((value, ctx) => {
  const rehearsal = value.approvalKind === "owner-draft-rehearsal";
  if (
    rehearsal
      ? !value.authorizationOutcome ||
        !value.draftTargets ||
        !value.publication ||
        !value.assessment
      : value.authorizationOutcome !== undefined || value.draftTargets !== undefined
  )
    ctx.addIssue({ code: "custom", message: "authorization discriminator mismatch" });
  // A completed-cycle release always states the judge's decision; nothing else carries one.
  if (
    (value.approvalKind === "editorial-cycle-complete") !==
    (value.judgmentDecision !== undefined)
  )
    ctx.addIssue({ code: "custom", message: "judgment decision mismatch" });
});
export type ArticleApprovedData = z.infer<typeof ArticleApprovedDataSchema>;

export function createArticleApprovedEvent(
  data: ArticleApprovedData,
  id: string,
): CloudEvent<ArticleApprovedData> {
  const owner = data.approvalKind === "owner-draft-rehearsal";
  const valid = owner
    ? ArticleOwnerDraftDataV2Schema.parse(data)
    : ArticleApprovedDataV1Schema.parse(data);
  return new CloudEvent<ArticleApprovedData>(
    {
      specversion: "1.0",
      id,
      source: owner ? "urn:steele:publishing:owner-draft" : SOURCE,
      type: owner ? ARTICLE_DRAFT_AUTHORIZED_EVENT_TYPE_V2 : ARTICLE_APPROVED_EVENT_TYPE_V1,
      time: valid.approvedAt,
      subject: `article/${valid.publicationId}/${valid.postId}`,
      correlationid: postCorrelationId(valid),
      datacontenttype: "application/json",
      dataschema: owner ? ARTICLE_DRAFT_AUTHORIZED_DATASCHEMA_V2 : ARTICLE_APPROVED_DATASCHEMA_V1,
      data: valid,
    },
    true,
  );
}

const EnvelopeSchema = z.looseObject({
  specversion: z.literal("1.0"),
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(500),
  type: z.enum([ARTICLE_APPROVED_EVENT_TYPE_V1, ARTICLE_DRAFT_AUTHORIZED_EVENT_TYPE_V2]),
  dataschema: z.enum([ARTICLE_APPROVED_DATASCHEMA_V1, ARTICLE_DRAFT_AUTHORIZED_DATASCHEMA_V2]),
  datacontenttype: z.literal("application/json"),
  subject: z.string().min(1),
});

export function parseArticleApprovedEvent(
  input: string,
): ArticleApprovedData & { eventId: string } {
  const envelope = EnvelopeSchema.parse(JSON.parse(input));
  const owner = envelope.type === ARTICLE_DRAFT_AUTHORIZED_EVENT_TYPE_V2;
  if (
    envelope.dataschema !==
    (owner ? ARTICLE_DRAFT_AUTHORIZED_DATASCHEMA_V2 : ARTICLE_APPROVED_DATASCHEMA_V1)
  )
    throw new Error("event version mismatch");
  const data: ArticleApprovedData = owner
    ? ArticleOwnerDraftDataV2Schema.parse(envelope.data)
    : ArticleApprovedDataV1Schema.parse(envelope.data);
  if (envelope.subject !== `article/${data.publicationId}/${data.postId}`) {
    throw new Error("subject does not match the article");
  }
  return { eventId: envelope.id, ...data };
}

export function articleApprovedDataJsonSchema(version: 1 | 2 = 1): Record<string, unknown> {
  return z.toJSONSchema(
    version === 1 ? ArticleApprovedDataV1Schema : ArticleOwnerDraftDataV2Schema,
  ) as Record<string, unknown>;
}
