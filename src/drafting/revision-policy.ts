import { z } from "zod";
import type { VerificationIssue, VerificationReport } from "./verify.js";

/**
 * Bounded draft revision decisions (#99, part of #44).
 *
 * A pure, deterministic policy: given how many revisions a draft has had,
 * the configured maximum, the exact draft and evidence identity, and a
 * validated verification report, decide whether to approve the exact draft,
 * request a targeted redraft, or skip with a reason.
 *
 * - At most two revisions by default; the configuration is validated.
 * - A report only counts for the draft and brief it was made for, so a
 *   changed draft can never inherit an earlier approval.
 * - Redraft feedback must point at actual passages of the draft.
 * - Exhausted revisions, or evidence gaps no redraft can repair, skip.
 *
 * No model calls, database access, events or publishing.
 */

export const DEFAULT_MAX_REVISIONS = 2;

export const RevisionPolicyConfigSchema = z
  .object({ maxRevisions: z.number().int().min(0).max(10).default(DEFAULT_MAX_REVISIONS) })
  .strict();
export type RevisionPolicyConfig = z.input<typeof RevisionPolicyConfigSchema>;

export interface RevisionInput {
  /** Revisions already made to reach the current draft (0 for the first draft). */
  revisionCount: number;
  /** The exact current draft. */
  draft: { hash: string; markdown: string };
  /** The exact evidence brief the draft was written from. */
  brief: { hash: string };
  report: Pick<VerificationReport, "verdict" | "draft" | "brief" | "issues">;
  /**
   * Set by the caller when the feedback depends on evidence the brief does
   * not have and research could not supply; a redraft cannot repair that.
   */
  evidenceGapUnrepairable?: boolean;
}

export type RevisionDecision =
  | { action: "approve"; draftHash: string; briefHash: string }
  | {
      action: "redraft";
      revision: number;
      feedback: Array<Required<Pick<VerificationIssue, "passage">> & VerificationIssue>;
    }
  | {
      action: "skip";
      reason:
        | "revisions-exhausted"
        | "unrepairable-evidence-gap"
        | "verifier-skipped"
        | "no-actionable-feedback";
    };

export class InvalidRevisionInputError extends Error {
  constructor(readonly reason: "invalid-config" | "invalid-count" | "stale-report") {
    super(`invalid revision input: ${reason}`);
    this.name = "InvalidRevisionInputError";
  }
}

export function decideRevision(
  input: RevisionInput,
  config: RevisionPolicyConfig = {},
): RevisionDecision {
  const parsed = RevisionPolicyConfigSchema.safeParse(config);
  if (!parsed.success) throw new InvalidRevisionInputError("invalid-config");
  const { maxRevisions } = parsed.data;
  if (
    !Number.isInteger(input.revisionCount) ||
    input.revisionCount < 0 ||
    input.revisionCount > maxRevisions
  ) {
    throw new InvalidRevisionInputError("invalid-count");
  }
  // The report must be about exactly this draft and this evidence.
  if (
    input.report.draft?.hash !== input.draft.hash ||
    input.report.brief?.hash !== input.brief.hash
  ) {
    throw new InvalidRevisionInputError("stale-report");
  }

  if (input.report.verdict === "approve" && input.report.issues.length === 0) {
    return { action: "approve", draftHash: input.draft.hash, briefHash: input.brief.hash };
  }
  if (input.report.verdict === "skip") return { action: "skip", reason: "verifier-skipped" };

  // Only feedback anchored to an actual passage of this draft is actionable.
  const feedback = input.report.issues.filter(
    (i): i is VerificationIssue & { passage: string } =>
      !!i.passage && input.draft.markdown.includes(i.passage),
  );
  // Rewording cannot supply evidence that research could not find.
  if (input.evidenceGapUnrepairable === true)
    return { action: "skip", reason: "unrepairable-evidence-gap" };
  if (feedback.length === 0) return { action: "skip", reason: "no-actionable-feedback" };
  if (input.revisionCount >= maxRevisions) return { action: "skip", reason: "revisions-exhausted" };
  return { action: "redraft", revision: input.revisionCount + 1, feedback };
}
