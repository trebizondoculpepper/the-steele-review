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
>;

const stageLabel = (stage: string): string => stage.replace(/-/g, " ");

/** First stage that has not completed, when the run is still in progress. */
function currentStage(stages: Input["stages"]): string | undefined {
  const pending = stages.find((s) => s.state === "pending");
  return pending?.stage;
}

/** First stage recorded as failed, with its detail when present. */
function failedStage(stages: Input["stages"]): { stage: string; detail?: string } | undefined {
  const failed = stages.find((s) => s.state === "failed");
  return failed === undefined
    ? undefined
    : { stage: failed.stage, ...(failed.detail ? { detail: failed.detail } : {}) };
}

export function explainTrace(t: Input): TraceExplanation {
  const failed = failedStage(t.stages);

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
      next: "Recover this revision; completed stage results are reused, so nothing already done is repeated.",
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
