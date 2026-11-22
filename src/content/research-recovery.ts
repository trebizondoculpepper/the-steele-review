import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact-reference.js";
const JobId = z.string().regex(/^research-[0-9a-f]{32}$/);
/** Explicit exact-request recovery, not general theme/evidence similarity. */
export const ResearchRecoveryBindingSchema = z
  .object({
    version: z.literal("retained-length-limit-v1"),
    originalJobId: JobId,
    jobId: JobId,
    discovery: ArtifactReferenceSchema,
    failedResult: ArtifactReferenceSchema,
    result: ArtifactReferenceSchema,
  })
  .strict();
export type ResearchRecoveryBinding = z.infer<typeof ResearchRecoveryBindingSchema>;
