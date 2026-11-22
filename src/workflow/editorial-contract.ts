import type { ExpectedWriterRecovery } from "../drafting/writer-attempts.js";
import type { EditorialLineage } from "../content/editorial-lineage.js";
import type { JudgmentHistory } from "../content/judgment-history.js";
import { z } from "zod";
import type { Ref } from "./article-run.js";

/**
 * What happens when the revision limit is reached without approval (#734):
 * `stop` records the unresolved outcome; `create-unpublished-draft` keeps the
 * last version as an unpublished draft (applied by the workflow, #731).
 */
export const EXHAUSTION_ACTIONS = ["stop", "create-unpublished-draft"] as const;
export type ExhaustionAction = (typeof EXHAUSTION_ACTIONS)[number];
export const DEFAULT_EXHAUSTION_ACTION: ExhaustionAction = "stop";

export const EditorialPolicySchema = z
  .object({
    version: z.literal("assess-judge-v1"),
    /**
     * Revision rounds after the initial assessment and judgment. The initial
     * review is not a round: a limit of 1 allows one substantive rewrite
     * after it; 0 allows none.
     */
    maxRevisions: z.number().int().min(0).max(5),
    deadlineMs: z.number().int().min(1000).max(3_600_000),
    /**
     * Resolved at submission (#734). Written only when not the default:
     * absent means `stop`, which also covers inputs saved before it existed.
     */
    onExhausted: z.enum(EXHAUSTION_ACTIONS).optional(),
  })
  .strict();
export type EditorialPolicy = z.infer<typeof EditorialPolicySchema>;
export const DEFAULT_EDITORIAL_POLICY: EditorialPolicy = {
  version: "assess-judge-v1",
  maxRevisions: 2,
  deadlineMs: 20 * 60_000,
};
/** The effective exhaustion action: an input without one keeps `stop`. */
export const exhaustionAction = (policy: EditorialPolicy): ExhaustionAction =>
  policy.onExhausted ?? DEFAULT_EXHAUSTION_ACTION;
/** Same effective policy, treating an absent exhaustion action as `stop`. */
export const sameEditorialPolicy = (a: EditorialPolicy, b: EditorialPolicy): boolean =>
  JSON.stringify({ ...a, onExhausted: exhaustionAction(a) }) ===
  JSON.stringify({ ...b, onExhausted: exhaustionAction(b) });
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
    // An unsupported action fails validation rather than falling back. The
    // default is not written: absent means `stop`, so inputs (and the
    // request-id input hashes recorded for them) match those saved before
    // the action existed.
    ...(env.STEELE_EDITORIAL_EXHAUSTION_ACTION?.trim() &&
    env.STEELE_EDITORIAL_EXHAUSTION_ACTION.trim() !== DEFAULT_EXHAUSTION_ACTION
      ? { onExhausted: env.STEELE_EDITORIAL_EXHAUSTION_ACTION.trim() }
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
    lineage?: EditorialLineage,
    beforeNewCall?: () => Promise<void>,
  ): Promise<{ ref: Ref; state: string; operationalFailure?: string }>;
  judge(
    assessment: Ref,
    attemptId: string,
    recoveryId?: string,
    history?: JudgmentHistory,
    lineage?: EditorialLineage,
    expectedRecovery?: ExpectedWriterRecovery,
    beforeNewCall?: () => Promise<void>,
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
    lineage?: EditorialLineage,
    beforeNewCall?: () => Promise<void>,
  ): Promise<{
    version?: EditorialVersion;
    failure?: string;
    mechanicalRun?: Ref;
    diagnostics?: Ref[];
    retainedAttempts?: Ref[];
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
  retainedWriterAttempts?: Ref[];
  reusedAssessments?: Ref[];
  retainedControlArtifacts?: Ref[];
  revisionAttempts?: number;
  terminal: "approved" | "unresolved" | "operational-stop" | "deadline";
  summary: Ref;
}
