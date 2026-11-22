import type { ArticleTrace } from "./articles.js";

/**
 * Plain-language explanation of an article run (#525).
 *
 * The trace already lists evidence; this says in one line what happened and
 * what to do next. Workflow termination is kept distinct from editorial
 * approval and delivery, so a completed workflow that failed verification is
 * never described as success.
 */

export interface TraceExplanation {
  /** One sentence describing the current state. */
  status: string;
  /** The single next action, or the exact reason nothing can proceed. */
  next?: string;
  /** Present only when the run stopped without completing its stages. */
  stoppedReason?: string;
}

type Input = Pick<
  ArticleTrace,
  "summary" | "editorial" | "outcome" | "reason" | "stages" | "research" | "approvalRecorded"
> & {
  /**
   * Whether the recovery action is available for this failure. Recovery only
   * supports a credit-stopped run, so anything else must not be advised to use
   * it.
   */
  recoveryAvailable?: boolean;
  /** The recorded recovery run for this revision, when one was started. */
  recovery?: {
    summary: "completed" | "failed" | "pending" | "not-started" | "unknown" | "unavailable";
    outcome?: string;
    /** The recovery's own sanitised diagnostic, when it recorded one. */
    reason?: string;
    verification?: { outcome: string };
  };
};

const stageLabel = (stage: string): string => stage.replace(/-/g, " ");

/** First stage that has not completed, when the run is still in progress. */
function currentStage(stages: Input["stages"]): string | undefined {
  const pending = stages.find((s) => s.state === "pending");
  return pending?.stage;
}

/** First stage recorded as failed, with its detail when present. */
function failedStage(stages: Input["stages"]): { stage: string; detail?: string } | undefined {
  const failed = stages.find((s) => s.state === "failed");
  if (failed === undefined) return undefined;
  // `summariseRun` may already prefix the detail with the stage name; strip it
  // so the explanation does not read "claims: claims: …".
  const prefix = `${failed.stage}: `;
  const detail = failed.detail?.startsWith(prefix)
    ? failed.detail.slice(prefix.length)
    : failed.detail;
  return { stage: failed.stage, ...(detail ? { detail } : {}) };
}

export function explainTrace(t: Input): TraceExplanation {
  const failed = failedStage(t.stages);

  // A run that has a recorded recovery is described by the recovery: the
  // original failure is history, not the current state.
  if (t.recovery) {
    const r = t.recovery;
    if (r.summary === "pending")
      return {
        status: "Recovery is running for this revision after the original run stopped.",
        next: "Wait for the recovery to finish; completed stage results are reused.",
      };
    if (r.summary === "unavailable" || r.summary === "unknown")
      return {
        status: "Recovery state unknown: the recorded recovery could not be read.",
        next: "Retry the status check; this is not a second failure and not evidence the recovery stopped.",
      };
    if (r.summary === "failed")
      return {
        status: "Recovery failed as well, so this revision still has no verified draft.",
        // Prefer the recovery's own diagnostic over the coarse outcome word.
        stoppedReason: r.reason ?? r.outcome ?? "the recovery run stopped",
        next: "Inspect both runs before attempting anything further; recovery is not re-offered automatically.",
      };
    if (r.summary === "completed") {
      const approved = r.verification?.outcome === "approved" || r.outcome === "verified";
      const rejected = r.verification?.outcome === "rejected" || r.outcome === "rejected";
      if (approved)
        return {
          status: "Recovered: the original failure was followed by a recovery that was verified and approved.",
          next: "Delivery is handled by the publisher; check receipts for the exact recovered draft.",
        };
      if (rejected)
        return {
          status: "Recovery completed, but verification rejected the recovered draft.",
          next: "Request a revision addressing the verifier's specific passages and reasons.",
        };
      return {
        status: "Recovery completed without a verified draft.",
        next: "Inspect the recovery's verification and decide whether to redraft.",
      };
    }
  }

  if (t.summary === "pending") {
    const stage = currentStage(t.stages);
    return {
      status: stage
        ? `Running: the ${stageLabel(stage)} stage is in progress.`
        : "Running: the workflow has not reported a stage yet.",
      next: "Wait for the stage to finish, or recover the run if it stops responding.",
    };
  }

  if (t.summary === "not-started") {
    return {
      status: "Not started: no workflow has run for this revision.",
      next: "Start a run for this exact revision.",
    };
  }

  if (t.summary === "failed") {
    // Prefer the stage's own detail, then the recorded reason, never both
    // concatenated into a duplicated prefix.
    const reason = t.reason;
    const stoppedReason = failed
      ? `${stageLabel(failed.stage)}: ${failed.detail ?? (reason?.startsWith(`${failed.stage}: `) ? reason.slice(failed.stage.length + 2) : (reason ?? "the stage failed"))}`
      : (reason ?? "the workflow stopped");
    return {
      status: "Failed: the workflow stopped before finishing its stages.",
      stoppedReason,
      next:
        t.recoveryAvailable === true
          ? "Recover this revision; completed stage results are reused, so nothing already done is repeated."
          : "Recovery is not available for this failure. Inspect the failing stage and the verifier history, fix the cause, and run the revision again.",
    };
  }

  if ((t.summary as string) === "unknown" || (t.summary as string) === "unavailable") {
    return {
      status: "State unknown: the workflow's status could not be read.",
      next: "Retry the status check; this is not evidence that the run stopped.",
    };
  }

  // Completed workflow: editorial outcome and delivery are separate facts.
  if (t.editorial === "verified") {
    const delivered = t.approvalRecorded === true;
    return {
      status: delivered
        ? "Verified and approved, and the approval was recorded for delivery."
        : "Verified and approved.",
      next: delivered
        ? "Delivery is handled by the publisher; check receipts for the exact draft."
        : "Record the approval to hand this exact draft to delivery.",
    };
  }
  if (t.editorial === "rejected") {
    return {
      status: "Workflow completed, but verification rejected the draft, so this is not a success.",
      next: "Request a revision addressing the verifier's specific passages and reasons.",
    };
  }
  if (t.editorial === "evidence-gap") {
    return {
      status: "Workflow completed with an evidence gap: there was not enough support to write a response.",
      next: "Commission or supply the missing research, then run the revision again.",
    };
  }
  if (t.editorial === "unverified") {
    return {
      status: "Workflow completed but the draft was not verified.",
      next: "Retry verification when the verifier is available; the saved draft is reused.",
    };
  }
  return {
    status: "Workflow completed with no editorial outcome recorded.",
    next: "Inspect the stages and verifier history to decide whether to redraft.",
  };
}

/** Render the explanation as the first block of the trace page. */
export function renderExplanation(explanation: TraceExplanation): string {
  const esc = (v: string) =>
    v.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    );
  return `<section class="explanation"><h2>What happened</h2><p>${esc(explanation.status)}</p>${
    explanation.stoppedReason ? `<p class="s-failed">Stopped: ${esc(explanation.stoppedReason)}</p>` : ""
  }${explanation.next ? `<p><strong>Next:</strong> ${esc(explanation.next)}</p>` : ""}</section>`;
}
