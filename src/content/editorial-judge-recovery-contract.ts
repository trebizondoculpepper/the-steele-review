import { z } from "zod";
import { ArtifactReferenceSchema } from "./artifact-reference.js";
import {
  ContinuationRequestIdSchema,
  safeContinuationReason,
} from "./editorial-continuation-contract.js";
import { EditorialRecoveryCheckpointSchema } from "../drafting/editorial-recovery-checkpoint.js";
export const EDITORIAL_JUDGE_RECOVERY_WORKFLOW = "EditorialJudgeRecovery";
export const RecoveryGenerationSchema = z.number().int().min(1).max(100);
export const JudgeRecoveryWindowSchema = z
  .object({
    version: z.literal("editorial-recovery-window-v1"),
    deadlineMs: z.number().int().min(1000).max(3600000),
  })
  .strict();
export type JudgeRecoveryWindow = z.infer<typeof JudgeRecoveryWindowSchema>;
export const JudgeRecoveryIntentSchema = z
  .object({
    version: z.literal("editorial-judge-recovery-intent-v1"),
    requestId: ContinuationRequestIdSchema,
    generation: RecoveryGenerationSchema,
    seed: EditorialRecoveryCheckpointSchema,
    window: JudgeRecoveryWindowSchema,
    taskDigest: z.string().regex(/^[0-9a-f]{64}$/),
    originalEditLimit: z.number().int().min(1).max(5),
    spentEdits: z.number().int().min(1).max(5),
    remainingEdits: z.number().int().min(0).max(4),
  })
  .strict()
  .refine((v) => v.spentEdits + v.remainingEdits === v.originalEditLimit, {
    message: "recovery cannot reset edit allowance",
  });
export type JudgeRecoveryIntent = z.infer<typeof JudgeRecoveryIntentSchema>;
export const JudgeRecoveryRunInputSchema = z
  .object({
    version: z.literal("editorial-judge-recovery-run-v1"),
    requestId: ContinuationRequestIdSchema,
    generation: RecoveryGenerationSchema,
    intent: ArtifactReferenceSchema,
  })
  .strict();
export type JudgeRecoveryRunInput = z.infer<typeof JudgeRecoveryRunInputSchema>;
const Stored = ArtifactReferenceSchema.omit({ hash: true })
  .extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
export const JudgeRecoveryResultSchema = z
  .object({
    version: z.literal("editorial-judge-recovery-result-v1"),
    outcome: z.enum(["verified", "rejected", "skipped", "failed"]),
    reason: z.string().max(300).optional(),
    summary: Stored,
    completedAt: z.iso.datetime(),
    draft: Stored.optional(),
    metadata: Stored.optional(),
    approvalEvent: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => v.outcome !== "verified" || (!!v.draft && !!v.metadata && !!v.approvalEvent), {
    message: "verified recovery needs exact version and approval",
  });
export type JudgeRecoveryResult = z.infer<typeof JudgeRecoveryResultSchema>;

export const safeJudgeRecoveryReason = (value: string | undefined) => {
  if (!value) return undefined;
  const known = new Set([
    "identity-conflict",
    "chain-mismatch",
    "parent-not-complete",
    "parent-result-mismatch",
    "window-mismatch",
    "task-mismatch",
    "not-denied",
    "approval-present-or-uncertain",
    "recovery-task-mismatch",
    "recovery-not-denied",
    "recovery-stale-base",
    "recovery-deadline",
    "recovery-approval-uncertain",
    "recovery-summary-unavailable",
  ]);
  return known.has(value) ? value : safeContinuationReason(value);
};
