import { escapeHtml, type DashboardView } from "./server.js";
import type { ReviewEntry, ReviewHistoryPort } from "./reviews.js";

/**
 * Read-only review history page (#499).
 *
 * Lists every saved verifier pass for one post, newest first, with its exact
 * reviewed draft, outcome, model/prompt identity, issues and scope. The final
 * `unresolved` wrapper is labelled as a terminal summary rather than another
 * model review. Manual editorial decisions are shown separately.
 */

export const REVIEW_PATH = "/reviews";

const ID = /^[a-z0-9][a-z0-9-]{0,199}$/;

const tone = (outcome: string) =>
  outcome === "approved" || outcome === "approve"
    ? "done"
    : outcome === "redraft" || outcome === "reject"
      ? "failed"
      : "pending";

const badge = (outcome: string) =>
  `<span class="s-${tone(outcome)}">${escapeHtml(outcome)}</span>`;

export function reviewViews(reviews: ReviewHistoryPort): DashboardView[] {
  const view: DashboardView = {
    path: REVIEW_PATH,
    title: "Review history",
    hidden: true,
    async render(url) {
      const publicationId = url.searchParams.get("publication") ?? "";
      const postId = url.searchParams.get("post") ?? "";
      if (!ID.test(publicationId) || !ID.test(postId)) {
        return '<p class="empty">Choose an article or draft to see its review history.</p>';
      }
      const page = Number.parseInt(url.searchParams.get("page") ?? "0", 10);
      let history;
      try {
        history = await reviews.forPost({ publicationId, postId }, Number.isFinite(page) ? page : 0);
      } catch {
        return '<p class="empty">Review history is unavailable.</p>';
      }
      const back = `<p><a href="/articles/trace?publication=${encodeURIComponent(publicationId)}&post=${encodeURIComponent(postId)}">Article trace</a> · <a href="/drafts?publication=${encodeURIComponent(publicationId)}&post=${encodeURIComponent(postId)}">Saved drafts</a></p>`;
      const stateNote =
        history.state === "unavailable"
          ? '<p class="empty">Saved review reports are unavailable.</p>'
          : history.state === "partial"
            ? '<p class="empty">Some saved reports could not be read or the bounded scan was incomplete; missing passes are not claimed as reviews.</p>'
            : history.state === "none"
              ? '<p class="empty">No saved verifier passes for this post.</p>'
              : "";

      const passRows = history.reviews.map((entry, index) => renderEntry(entry, index)).join("");
      const editorial = history.editorial.length
        ? `<h2>Manual editorial decisions</h2><p class="empty">Recorded by the owner; separate from automatic verification.</p><div class="wrap"><table><thead><tr><th>Action</th><th>Decided</th><th>Draft</th><th>Comment</th></tr></thead><tbody>${history.editorial
            .map(
              (d: { action: string; decidedAt: string; draftHash?: string; comment?: string }) =>
                `<tr><td>${badge(d.action)}</td><td>${escapeHtml(d.decidedAt)}</td><td>${d.draftHash ? `<code>${escapeHtml(d.draftHash)}</code>` : ""}</td><td>${d.comment ? escapeHtml(d.comment) : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : "";
      const pager =
        history.next === undefined
          ? ""
          : `<p><a href="${REVIEW_PATH}?publication=${encodeURIComponent(publicationId)}&post=${encodeURIComponent(postId)}&page=${history.next}">Older passes</a></p>`;
      return `${back}<h1>Review history</h1><p>${escapeHtml(publicationId)}/${escapeHtml(postId)}</p>${stateNote}${passRows}${editorial}${pager}`;
    },
  };
  return [view];
}

function renderEntry(entry: ReviewEntry, index: number): string {
  if (entry.kind === "unreadable") {
    return `<h2>Pass ${index + 1}</h2><p class="empty">Saved report <code>${escapeHtml(entry.path)}</code> could not be read; no review is claimed.</p>`;
  }
  if (entry.kind === "unresolved") {
    const issues = renderIssues(entry.issues);
    return `<h2>Pass ${index + 1}: terminal unresolved</h2>
<p>Final summary after ${entry.revisions} revision(s), saved as a terminal wrapper rather than another model review.</p>
<p>Report <code>${escapeHtml(entry.reportPath)}</code></p>${issues}`;
  }
  return `<h2>Pass ${index + 1}: ${badge(entry.outcome)}</h2>
<dl><dt>Reviewed draft</dt><dd><code>${escapeHtml(entry.draft.hash)}</code> · ${escapeHtml(entry.draft.path)}${entry.draft.repository ? "" : " (legacy worker report)"}</dd>
<dt>Verified</dt><dd>${entry.verifiedAt ? escapeHtml(entry.verifiedAt) : '<span class="empty">not recorded</span>'}</dd>
<dt>Scope</dt><dd>${escapeHtml(entry.scope)}</dd>
${entry.modelVersion ? `<dt>Model</dt><dd>${escapeHtml(entry.modelVersion)}</dd>` : ""}
${entry.promptVersion ? `<dt>Prompt</dt><dd><code>${escapeHtml(entry.promptVersion)}</code></dd>` : ""}
<dt>Checks</dt><dd>${entry.checks.map((c) => escapeHtml(c)).join(", ") || "none recorded"}</dd></dl>
${renderIssues(entry.issues)}`;
}

function renderIssues(issues: { passage: string; reason: string; severity: string }[]): string {
  if (issues.length === 0) return '<p class="empty">No issues recorded for this pass.</p>';
  return `<div class="wrap"><table><thead><tr><th>Severity</th><th>Passage</th><th>Reason</th></tr></thead><tbody>${issues
    .map(
      (i) =>
        `<tr><td>${badge(i.severity)}</td><td><blockquote>${escapeHtml(i.passage)}</blockquote></td><td>${escapeHtml(i.reason)}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}
