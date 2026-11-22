import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact-reference.js";
import { EditorialContinuationInputSchema } from "../drafting/editorial-continuation.js";
import { EditorialPolicySchema } from "../workflow/editorial-contract.js";
export const EDITORIAL_CONTINUATION_WORKFLOW = "EditorialContinuation";
export const ContinuationRequestIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
/** Frozen before submission; excludes deployment configuration and credentials. */
export const EditorialContinuationIntentSchema = z
  .object({
    version: z.literal("editorial-continuation-intent-v1"),
    requestId: ContinuationRequestIdSchema,
    seed: EditorialContinuationInputSchema,
    policy: EditorialPolicySchema.refine((p) => p.maxRevisions >= 1, {
      message: "continuation needs an edit allowance",
    }),
  })
  .strict();
export type EditorialContinuationIntent = z.infer<typeof EditorialContinuationIntentSchema>;
/** Distinct serialized contract: existing ArticleRun journals never change branch. */
export const EditorialContinuationRunInputSchema = z
  .object({
    version: z.literal("editorial-continuation-run-v1"),
    requestId: ContinuationRequestIdSchema,
    intent: ArtifactReferenceSchema,
  })
  .strict();
export type EditorialContinuationRunInput = z.infer<typeof EditorialContinuationRunInputSchema>;
const StoredRefSchema = ArtifactReferenceSchema.omit({ hash: true })
  .extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
export const EditorialContinuationResultSchema = z
  .object({
    version: z.literal("editorial-continuation-result-v1"),
    outcome: z.enum(["verified", "rejected", "skipped", "failed"]),
    reason: z.string().max(300).optional(),
    summary: StoredRefSchema,
    completedAt: z.iso.datetime(),
    draft: StoredRefSchema.optional(),
    metadata: StoredRefSchema.optional(),
    approvalEvent: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => v.outcome !== "verified" || (!!v.draft && !!v.metadata && !!v.approvalEvent), {
    message: "verified result needs exact version and approval",
  });
/** Only fixed domain/status wording can reach CLI/status, never transport text. */
export const safeContinuationReason = (value: string | undefined) => {
  if (!value) return undefined;
  const allowed = new Set([
    "invalid-input",
    "parent-mismatch",
    "parent-not-resumable",
    "version-mismatch",
    "source-mismatch",
    "judgment-invalid",
    "history-mismatch",
    "stale-base",
    "unreadable",
    "identity-conflict",
    "parent-not-complete",
    "parent-result-mismatch",
    "policy-mismatch",
    "completion-unconfigured",
    "preflight-unavailable",
    "editorial-deadline",
    "revision-unavailable",
    "revision-failed",
    "writer-archive-failed",
    "writer-attempt-busy",
    "writer-attempt-interrupted",
    "mechanical-deadline-exhausted",
    "provider-failed",
    "malformed-output",
    "invalid-draft",
    "source-url-mismatch",
    "no-source-url",
    "article-conflict",
    "credit-exhausted",
    "editorial-stage-unavailable",
    "editorial-summary-unavailable",
    "editorial revision limit reached",
    "editorial deadline reached",
    "assessment: credit-exhausted",
    "judgment: credit-exhausted",
    "editorial judgment gated",
    "editorial judgment malformed",
    "editorial judgment provider-failed",
  ]);
  if (allowed.has(value)) return value;
  return "stage-stopped";
};
