import { escapeHtml, type DashboardView } from "./server.js";
import type { AssessmentRow, AssessmentsPort } from "./assessments.js";
import type { AssessmentState } from "../drafting/article-assessment.js";

/**
 * Assessments browser (#642). Read-only: shows the exact saved assessor
 * records and their retained findings; absence is never approval.
 */

const TONE: Record<AssessmentState, string> = {
  "no-faults": "done",
  findings: "pending",
  incomplete: "pending",
  malformed: "failed",
  "provider-failed": "failed",
};
const LABEL: Record<AssessmentState, string> = {
  findings: "findings",
  "no-faults": "no faults",
  incomplete: "incomplete",
  malformed: "malformed",
  "provider-failed": "provider failed",
};
const badge = (state: AssessmentState) =>
  `<span class="s-${TONE[state]}">${escapeHtml(LABEL[state])}</span>`;

const STATES = Object.keys(LABEL) as AssessmentState[];

export function assessmentViews(assessments?: AssessmentsPort): DashboardView[] {
  const list: DashboardView = {
    path: "/assessments",
    title: "Assessments",
    async render(url) {
      if (!assessments)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const query = (url.searchParams.get("q") ?? "").slice(0, 200);
      const post = (url.searchParams.get("post") ?? "").slice(0, 400);
      const stateRaw = url.searchParams.get("state") ?? "";
      const state = STATES.find((s) => s === stateRaw);
      const after = url.searchParams.get("after") ?? undefined;
      const listing = await assessments.list({
        ...(query ? { query } : {}),
        ...(post ? { post } : {}),
        ...(state ? { state } : {}),
        ...(after ? { after } : {}),
      });
      const option = (v: string, label: string, selected: boolean) =>
        `<option value="${v}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const form = `<form method="get" action="/assessments"><label>Text <input name="q" value="${escapeHtml(query)}" maxlength="200"></label> <label>Post <input name="post" value="${escapeHtml(post)}" maxlength="400" placeholder="publication/post"></label> <label>State <select name="state">${option("", "all", !state)}${STATES.map((s) => option(s, LABEL[s], state === s)).join("")}</select></label> <button>Filter</button></form>`;
      if (listing.state === "unavailable")
        return `${form}<p class="empty">Saved assessments are unavailable right now.</p>`;
      const notes = [
        listing.partial ? "This page reached its scan bound; continue for later attempts." : "",
        listing.unreadable ? `${listing.unreadable} saved assessment file(s) could not be read.` : "",
      ]
        .filter(Boolean)
        .map((n) => `<p class="empty">${escapeHtml(n)}</p>`)
        .join("");
      const rows = listing.rows
        .map((r) => {
          const link = `/assessments/view?${new URLSearchParams({ path: r.path }).toString()}`;
          return `<tr><td><a href="${escapeHtml(link)}">${escapeHtml(r.publicationId)}/${escapeHtml(r.postId)}</a></td><td>${badge(r.state)}</td><td>${r.findings ?? "—"}</td><td>${r.deterministicFindings}</td><td>${escapeHtml(r.assessorModel)}</td><td>${escapeHtml(r.assessedAt.slice(0, 19).replace("T", " "))} UTC</td></tr>`;
        })
        .join("");
      const next =
        listing.next !== undefined
          ? `<p><a href="/assessments?${escapeHtml(new URLSearchParams({ ...(query ? { q: query } : {}), ...(post ? { post } : {}), ...(state ? { state } : {}), after: listing.next }).toString())}">Continue</a></p>`
          : "";
      if (listing.rows.length === 0 && listing.next === undefined) {
        return `${form}${notes}<p class="empty">${query || post || state ? "No saved assessments match this filter." : "No assessor attempts have been saved yet. This is not approval."}</p>`;
      }
      return `${form}${notes}<p>Each row is one saved assessor attempt. A missing or failed assessment is never approval.</p>
<div class="wrap"><table><thead><tr><th>Article</th><th>State</th><th>Findings</th><th>Deterministic</th><th>Assessor</th><th>Assessed</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };

  const view: DashboardView = {
    path: "/assessments/view",
    title: "Assessment",
    hidden: true,
    async render(url) {
      if (!assessments)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const path = url.searchParams.get("path") ?? "";
      const found = await assessments.detail(path);
      if (!found) return '<p class="empty">Choose a saved assessment from the list.</p>';
      const r: AssessmentRow = found.row;
      const facts: [string, string][] = [
        ["Article", `${escapeHtml(r.publicationId)}/${escapeHtml(r.postId)}`],
        ["State", badge(r.state)],
        ["Findings recorded", r.findings === undefined ? "not recorded" : String(r.findings)],
        ["Deterministic findings", String(r.deterministicFindings)],
        ["Assessor model", escapeHtml(r.assessorModel)],
        ["Assessor prompt", `<code>${escapeHtml(r.promptVersion)}</code>`],
        ["Assessed", escapeHtml(r.assessedAt)],
        ["Saved record", `<code>${escapeHtml(path)}</code>`],
      ];
      const deterministic = found.deterministic.length
        ? `<ul>${found.deterministic
            .map(
              (d) =>
                `<li><blockquote>${escapeHtml(d.passage)}</blockquote>${escapeHtml(d.reason)}</li>`,
            )
            .join("")}</ul>`
        : '<p class="empty">No deterministic findings were recorded.</p>';
      const document = found.documentUnreadable
        ? '<p class="empty">The retained findings document could not be read.</p>'
        : found.document === undefined
          ? '<p class="empty">No findings document was retained for this attempt.</p>'
          : `<pre>${escapeHtml(found.document)}</pre>`;
      return `<p><a href="/assessments">All assessments</a></p>
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<h2>Deterministic findings</h2>${deterministic}
<h2>Retained findings document</h2><p class="empty">Exactly as received; a complete assessment ends with the terminator, and only “No faults found.” means no faults.</p>${document}`;
    },
  };
  return [list, view];
}
