import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact-reference.js";
/** Exact earlier reviewed versions, chosen only from this bounded editorial loop. */
export const JudgmentHistorySchema = z
  .array(
    z
      .object({
        judgment: ArtifactReferenceSchema,
        assessment: ArtifactReferenceSchema,
        body: ArtifactReferenceSchema,
        metadata: ArtifactReferenceSchema,
      })
      .strict(),
  )
  .max(5)
  .superRefine((history, ctx) => {
    const ids = history.map((x) => JSON.stringify(x.judgment));
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "duplicate judgment history" });
  });
export type JudgmentHistory = z.infer<typeof JudgmentHistorySchema>;
