import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact-reference.js";
export const EditorialRecoveryBindingInputSchema = z
  .object({
    publicationId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    postId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    requestId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    generation: z.number().int().min(1).max(100),
    capture: ArtifactReferenceSchema,
    taskDigest: z.string().regex(/^[0-9a-f]{64}$/),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    intent: ArtifactReferenceSchema,
    parentSummary: ArtifactReferenceSchema,
  })
  .strict();
export const EditorialRecoveryBindingSchema = EditorialRecoveryBindingInputSchema.extend({
  workflowKey: z.string().min(1).max(1000),
  recordedAt: z.iso.datetime(),
}).strict();
export type EditorialRecoveryBindingInput = z.infer<typeof EditorialRecoveryBindingInputSchema>;
export type EditorialRecoveryBinding = z.infer<typeof EditorialRecoveryBindingSchema>;
