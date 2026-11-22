import { escapeHtml } from "./server.js";
import type { AssessmentsPort, AssessmentRow } from "./assessments.js";
import type { JudgmentRow, JudgmentsPort } from "./judgments.js";

/**
 * Editorial timeline for one article (#644).
 *
 * Merges saved assessor attempts and judge attempts chronologically, so the
 * owner sees every real pass — including failed and gated ones — with links to
 * the exact records and their pinned versions. It never recomputes a judgement,
 * counts a terminal wrapper as a pass, or labels a current article approved
 * from an older record.
 */

type TimelineEntry =
  | { at: string; kind: "assessment"; row: AssessmentRow }
  | { at: string; kind: "judgment"; row: JudgmentRow };

const assessmentBadge = (state: AssessmentRow["state"]) =>
  `<span class="s-${
    state === "no-faults" ? "done" : state === "malformed" || state === "provider-failed" ? "failed" : "pending"
  }">assessment: ${escapeHtml(state)}</span>`;

const judgmentBadge = (row: JudgmentRow) =>
  `<span class="s-${
    row.state === "decided" && row.decision === "approve"
      ? "done"
      : row.state === "malformed" || row.state === "provider-failed"
        ? "failed"
        : "pending"
  }">judgment: ${escapeHtml(row.state)} / ${escapeHtml(row.decision)}</span>`;

export interface EditorialTimelineData {
  assessments: AssessmentRow[];
  judgments: JudgmentRow[];
  assessmentsPartial: boolean;
  judgmentsPartial: boolean;
  assessmentsUnreadable: number;
  judgmentsUnreadable: number;
  assessmentsUnavailable: boolean;
  judgmentsUnavailable: boolean;
}

export async function loadEditorialTimeline(
  deps: { assessments?: AssessmentsPort; judgments?: JudgmentsPort },
  post: { publicationId: string; postId: string },
): Promise<EditorialTimelineData> {
  const key = `${post.publicationId}/${post.postId}`;
  let assessments: AssessmentRow[] = [];
  let judgments: JudgmentRow[] = [];
  let assessmentsPartial = false;
  let judgmentsPartial = false;
  let assessmentsUnreadable = 0;
  let judgmentsUnreadable = 0;
  let assessmentsUnavailable = false;
  let judgmentsUnavailable = false;
  if (deps.assessments) {
    try {
      const listing = await deps.assessments.list({ post: key });
      if (listing.state === "unavailable") assessmentsUnavailable = true;
      assessments = listing.rows;
      assessmentsPartial = listing.partial || listing.next !== undefined;
      assessmentsUnreadable = listing.unreadable;
    } catch {
      assessmentsUnavailable = true;
    }
  }
  if (deps.judgments) {
    try {
      const listing = await deps.judgments.list({ post: key });
      if (listing.state === "unavailable") judgmentsUnavailable = true;
      judgments = listing.rows;
      judgmentsPartial = listing.partial || listing.next !== undefined;
      judgmentsUnreadable = listing.unreadable;
    } catch {
      judgmentsUnavailable = true;
    }
  }
  return {
    assessments,
    judgments,
    assessmentsPartial,
    judgmentsPartial,
    assessmentsUnreadable,
    judgmentsUnreadable,
    assessmentsUnavailable,
    judgmentsUnavailable,
  };
}

export function renderEditorialTimeline(
  data: EditorialTimelineData,
  post: { publicationId: string; postId: string },
): string {
  if (!data.assessments.length && !data.judgments.length && !data.assessmentsUnavailable && !data.judgmentsUnavailable) {
    return `<h2>Editorial timeline</h2><p class="empty">No assessor or judge attempts are saved for this article yet. This is not approval.</p>`;
  }
  const entries: TimelineEntry[] = [
    ...data.assessments.map((row) => ({ at: row.assessedAt, kind: "assessment" as const, row })),
    ...data.judgments.map((row) => ({ at: row.decidedAt, kind: "judgment" as const, row })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind));

  const rows = entries
    .map((entry) => {
      if (entry.kind === "assessment") {
        const r = entry.row;
        const link = `/assessments/view?path=${encodeURIComponent(r.path)}`;
        return `<tr><td>${escapeHtml(r.assessedAt)}</td><td>${assessmentBadge(r.state)}</td><td><a href="${escapeHtml(link)}">Assessment</a> · ${r.findings === undefined ? "findings not recorded" : `${r.findings} finding(s)`} · ${r.deterministicFindings} deterministic</td><td><code>${escapeHtml(r.assessorModel)}</code><br><span class="empty">${escapeHtml(r.promptVersion)}</span></td></tr>`;
      }
      const r = entry.row;
      const link = `/judgments/view?path=${encodeURIComponent(r.path)}`;
      return `<tr><td>${escapeHtml(r.decidedAt)}</td><td>${judgmentBadge(r)}</td><td><a href="${escapeHtml(link)}">Judgment</a> · ${r.gateCount} gate(s)${r.decision === "revise" ? " · requested an editorial revision" : ""}</td><td>${r.judgeModel ? `<code>${escapeHtml(r.judgeModel)}</code><br><span class="empty">${escapeHtml(r.promptVersion ?? "")}</span>` : '<span class="empty">judge not recorded</span>'}</td></tr>`;
    })
    .join("");

  const notes = [
    entries.length === 0
      ? "No readable assessor or judge attempts are saved for this article; this is not approval."
      : "",
    data.assessmentsUnavailable ? "Assessor attempts are unavailable." : "",
    data.judgmentsUnavailable ? "Judge attempts are unavailable." : "",
    data.assessmentsPartial || data.judgmentsPartial
      ? "This timeline is bounded; open the full collections for every attempt."
      : "",
    data.assessmentsUnreadable + data.judgmentsUnreadable > 0
      ? `${data.assessmentsUnreadable + data.judgmentsUnreadable} saved record(s) could not be read.`
      : "",
  ]
    .filter(Boolean)
    .map((n) => `<p class="empty">${escapeHtml(n)}</p>`)
    .join("");
  const postQuery = new URLSearchParams({ post: `${post.publicationId}/${post.postId}` }).toString();
  return `<h2>Editorial timeline</h2>
<p class="empty">Chronological assessor and judge attempts. “Revise” is a requested editorial correction, not publication; failed, gated and malformed passes are shown, and a missing pass is never approval. Mechanical writer repair turns are not editorial revisions.</p>
<div class="wrap"><table><thead><tr><th>When</th><th>Outcome</th><th>Record</th><th>Model / prompt</th></tr></thead><tbody>${rows}</tbody></table></div>
${notes}
<p><a href="/assessments?${escapeHtml(postQuery)}">All assessor attempts</a> · <a href="/judgments?${escapeHtml(postQuery)}">All judge attempts</a></p>`;
}
