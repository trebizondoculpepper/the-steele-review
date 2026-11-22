import { z } from "zod";
import type { Ref } from "./article-run.js";

export const EditorialPolicySchema = z
  .object({
    version: z.literal("assess-judge-v1"),
    maxRevisions: z.number().int().min(0).max(5),
    deadlineMs: z.number().int().min(1000).max(3_600_000),
  })
  .strict();
export type EditorialPolicy = z.infer<typeof EditorialPolicySchema>;
export const DEFAULT_EDITORIAL_POLICY: EditorialPolicy = {
  version: "assess-judge-v1",
  maxRevisions: 2,
  deadlineMs: 20 * 60_000,
};
/** Read once at submission; the resolved values are serialized into the workflow journal. */
export function editorialPolicyFromEnv(env: Record<string, string | undefined>): EditorialPolicy {
  return EditorialPolicySchema.parse({
    ...DEFAULT_EDITORIAL_POLICY,
    ...(env.STEELE_EDITORIAL_MAX_REVISIONS?.trim()
      ? { maxRevisions: Number(env.STEELE_EDITORIAL_MAX_REVISIONS) }
      : {}),
    ...(env.STEELE_EDITORIAL_DEADLINE_MS?.trim()
      ? { deadlineMs: Number(env.STEELE_EDITORIAL_DEADLINE_MS) }
      : {}),
  });
}
export interface EditorialVersion {
  draft: Ref;
  metadata: Ref;
}
export interface EditorialStages {
  prepare(draft: Ref, pkg: Ref): Promise<EditorialVersion>;
  assess(
    version: EditorialVersion,
    pkg: Ref,
    attemptId: string,
    recoveryId?: string,
  ): Promise<{ ref: Ref; state: string; operationalFailure?: string }>;
  judge(
    assessment: Ref,
    attemptId: string,
    recoveryId?: string,
  ): Promise<{
    ref: Ref;
    decision: "approve" | "revise" | "none";
    state: string;
    operationalFailure?: string;
  }>;
  revise(
    version: EditorialVersion,
    pkg: Ref,
    judgment: Ref,
    number: number,
    sourceUrl: string,
    recoveryId?: string,
  ): Promise<{
    version?: EditorialVersion;
    failure?: string;
    mechanicalRun?: Ref;
    diagnostics?: Ref[];
  }>;
  approve(judgment: Ref): Promise<{ eventId: string }>;
}
export interface EditorialHistory {
  version: "assess-judge-v1";
  initial: EditorialVersion;
  assessments: Ref[];
  judgments: Ref[];
  revisions: EditorialVersion[];
  mechanicalRuns: Ref[];
  diagnostics: Ref[];
  terminal: "approved" | "unresolved" | "operational-stop" | "deadline";
  summary: Ref;
}
