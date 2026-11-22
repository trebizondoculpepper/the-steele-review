import { z } from "zod";
import { createHash } from "node:crypto";
import { ArtifactReferenceSchema } from "./artifact-reference.js";

export const OWNER_DRAFT_POLICY = "owner-one-revision-unpublished-v1";
export const DRAFT_CAPABILITY = "unpublished-no-email-v1";
export const DraftTargetSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    provider: z.enum(["dummy", "substack"]),
    action: z.literal("draft"),
    capability: z.literal(DRAFT_CAPABILITY),
    /** Opaque adapter identity; never an origin, account name or credential. */
    identity: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
export type DraftTarget = z.infer<typeof DraftTargetSchema>;

export const OwnerDraftRequestSchema = z
  .object({
    version: z.literal("owner-draft-rehearsal-request-v1"),
    requestId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    policy: z.literal(OWNER_DRAFT_POLICY),
    findingsAcknowledged: z.literal(true),
    parent: z
      .object({ workflowKey: z.string().min(1).max(1000), summary: ArtifactReferenceSchema })
      .strict(),
    body: ArtifactReferenceSchema,
    metadata: ArtifactReferenceSchema,
    publication: ArtifactReferenceSchema,
    package: ArtifactReferenceSchema,
    assessment: ArtifactReferenceSchema,
    judgment: ArtifactReferenceSchema,
    mechanicalRun: ArtifactReferenceSchema,
    destinations: z.array(DraftTargetSchema).length(3),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (new Set(r.destinations.map((d) => d.name)).size !== r.destinations.length)
      ctx.addIssue({ code: "custom", message: "duplicate destination" });
    for (const name of ["dummy-a", "dummy-b"])
      if (!r.destinations.some((d) => d.name === name && d.provider === "dummy"))
        ctx.addIssue({ code: "custom", message: "dummy destinations required" });
    if (
      r.destinations.filter(
        (d) => d.provider === "substack" && !["dummy-a", "dummy-b"].includes(d.name),
      ).length !== 1
    )
      ctx.addIssue({ code: "custom", message: "one real Substack draft destination required" });
  });
export type OwnerDraftRequest = z.infer<typeof OwnerDraftRequestSchema>;

export const OwnerDraftAuthorizationSchema = z
  .object({
    kind: z.literal("owner-draft-rehearsal"),
    outcome: z.literal("owner-authorized-draft"),
    request: OwnerDraftRequestSchema,
    post: z
      .object({
        publicationId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
        postId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
      })
      .strict(),
    parentOutcome: z.literal("rejected"),
    adoptedRevisionCount: z.literal(1),
    authorizedAt: z.iso.datetime(),
  })
  .strict();
export type OwnerDraftAuthorization = z.infer<typeof OwnerDraftAuthorizationSchema>;

export const OwnerDraftBindingSchema = z
  .object({
    publicationId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    postId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    requestId: OwnerDraftRequestSchema.shape.requestId,
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    versionIdentity: z.string().regex(/^[0-9a-f]{64}$/),
    recordedAt: z.iso.datetime(),
  })
  .strict();
export type OwnerDraftBinding = z.infer<typeof OwnerDraftBindingSchema>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const ownerDraftRequestHash = (request: OwnerDraftRequest) =>
  digest(OwnerDraftRequestSchema.parse(request));
export const ownerDraftVersionIdentity = (request: OwnerDraftRequest) =>
  digest([request.parent.summary, request.body, request.metadata, request.publication]);
