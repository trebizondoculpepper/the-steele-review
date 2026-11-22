import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema as Ref } from "./artifact-reference.js";
import { OwnerDraftTargetsSchema } from "./owner-draft-authorization.js";
import { EditorialPolicyObservationSchema } from "../config/editorial-live-policy.js";

/** Separate from retained-parent adoption: a normal invocation seals its own exact output. */
export const ConfiguredDraftCheckpointSchema = z
  .object({
    version: z.literal("normal-editorial-draft-checkpoint-v1"),
    workflowKey: z.string().min(1).max(1000),
    /** Validated separately with the normal input schema; original serialization pins its intent hash. */
    input: z.record(z.string(), z.unknown()),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    body: Ref,
    metadata: Ref,
    publication: Ref,
    package: Ref,
    assessment: Ref,
    judgment: Ref,
    mechanicalRun: Ref,
    sourceContext: Ref,
    assessments: z.array(Ref).min(1).max(6),
    judgments: z.array(Ref).min(1).max(6),
    initial: z.object({ body: Ref, metadata: Ref }).strict(),
    revisions: z.array(z.object({ body: Ref, metadata: Ref }).strict()).max(5),
    mechanicalRuns: z.array(Ref).max(5),
    appliedPolicy: EditorialPolicyObservationSchema,
  })
  .strict();
export type ConfiguredDraftCheckpoint = z.infer<typeof ConfiguredDraftCheckpointSchema>;
export const ConfiguredDraftRequestSchema = z
  .object({
    version: z.literal("configured-unpublished-draft-request-v1"),
    requestId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    checkpoint: Ref,
    body: Ref,
    metadata: Ref,
    publication: Ref,
    package: Ref,
    assessment: Ref,
    judgment: Ref,
    destinations: OwnerDraftTargetsSchema,
  })
  .strict();
export type ConfiguredDraftRequest = z.infer<typeof ConfiguredDraftRequestSchema>;
export const ConfiguredDraftAuthorizationSchema = z
  .object({
    kind: z.literal("owner-draft-rehearsal"),
    outcome: z.literal("owner-authorized-draft"),
    request: ConfiguredDraftRequestSchema,
    post: z
      .object({ publicationId: z.string().min(1).max(200), postId: z.string().min(1).max(200) })
      .strict(),
    authorizationBasis: z.literal("live-configured-normal-flow-v1"),
    authorizedAt: z.iso.datetime(),
  })
  .strict();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const configuredDraftRequestHash = (request: ConfiguredDraftRequest) =>
  digest(ConfiguredDraftRequestSchema.parse(request));
export const configuredDraftVersionIdentity = (request: ConfiguredDraftRequest) =>
  digest([request.checkpoint, request.body, request.metadata, request.publication]);
