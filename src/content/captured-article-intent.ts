import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact-reference.js";
export const CapturedArticleIntentInputSchema = z
  .object({
    publicationId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    postId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    input: ArtifactReferenceSchema,
  })
  .strict();
export const CapturedArticleIntentSchema = CapturedArticleIntentInputSchema.extend({
  requestId: z.string().regex(/^capture-[0-9a-f]{64}$/),
  workflowKey: z.string().min(1).max(1000),
  recordedAt: z.iso.datetime(),
});
export type CapturedArticleIntent = z.infer<typeof CapturedArticleIntentSchema>;
