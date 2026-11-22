import { escapeHtml, type DashboardView } from "./server.js";
import type { JudgmentDecision, JudgmentRow, JudgmentState, JudgmentsPort } from "./judgments.js";

/**
 * Judgments browser (#643). Read-only view of saved judge attempts and the
 * revision guidance they requested. Absence or failure is never approval.
 */

const STATE_TONE: Record<JudgmentState, string> = {
  decided: "done",
  gated: "pending",
  malformed: "failed",
  "provider-failed": "failed",
};
const DECISION_LABEL: Record<JudgmentDecision, string> = {
  approve: "approve",
  revise: "revise",
  none: "no decision",
};
const badge = (state: JudgmentState) =>
  `<span class="s-${STATE_TONE[state]}">${escapeHtml(state)}</span>`;
const decisionBadge = (decision: JudgmentDecision) =>
  `<span class="s-${decision === "approve" ? "done" : decision === "revise" ? "pending" : "unknown"}">${escapeHtml(DECISION_LABEL[decision])}</span>`;

const STATES = Object.keys(STATE_TONE) as JudgmentState[];
const DECISIONS = Object.keys(DECISION_LABEL) as JudgmentDecision[];

export function judgmentViews(judgments?: JudgmentsPort): DashboardView[] {
  const list: DashboardView = {
    path: "/judgments",
    title: "Judgments",
    async render(url) {
      if (!judgments)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const query = (url.searchParams.get("q") ?? "").slice(0, 200);
      const post = (url.searchParams.get("post") ?? "").slice(0, 400);
      const stateRaw = url.searchParams.get("state") ?? "";
      const decisionRaw = url.searchParams.get("decision") ?? "";
      const state = STATES.find((s) => s === stateRaw);
      const decision = DECISIONS.find((d) => d === decisionRaw);
      const after = url.searchParams.get("after") ?? undefined;
      const listing = await judgments.list({
        ...(query ? { query } : {}),
        ...(post ? { post } : {}),
        ...(state ? { state } : {}),
        ...(decision ? { decision } : {}),
        ...(after ? { after } : {}),
      });
      const option = (v: string, label: string, selected: boolean) =>
        `<option value="${v}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const form = `<form method="get" action="/judgments"><label>Text <input name="q" value="${escapeHtml(query)}" maxlength="200"></label> <label>Post <input name="post" value="${escapeHtml(post)}" maxlength="400" placeholder="publication/post"></label> <label>State <select name="state">${option("", "all", !state)}${STATES.map((s) => option(s, s, state === s)).join("")}</select></label> <label>Decision <select name="decision">${option("", "all", !decision)}${DECISIONS.map((d) => option(d, DECISION_LABEL[d], decision === d)).join("")}</select></label> <button>Filter</button></form>`;
      if (listing.state === "unavailable")
        return `${form}<p class="empty">Saved judgments are unavailable right now.</p>`;
      const notes = [
        listing.partial ? "This page reached its scan bound; continue for later attempts." : "",
        listing.unreadable ? `${listing.unreadable} saved judgment file(s) could not be read.` : "",
      ]
        .filter(Boolean)
        .map((n) => `<p class="empty">${escapeHtml(n)}</p>`)
        .join("");
      const rows = listing.rows
        .map((r) => {
          const link = `/judgments/view?${new URLSearchParams({ path: r.path }).toString()}`;
          return `<tr><td><a href="${escapeHtml(link)}">${escapeHtml(r.publicationId)}/${escapeHtml(r.postId)}</a></td><td>${badge(r.state)}</td><td>${decisionBadge(r.decision)}</td><td>${r.gateCount}</td><td>${r.judgeModel ? escapeHtml(r.judgeModel) : '<span class="empty">not recorded</span>'}</td><td>${escapeHtml(r.decidedAt.slice(0, 19).replace("T", " "))} UTC</td></tr>`;
        })
        .join("");
      const next =
        listing.next !== undefined
          ? `<p><a href="/judgments?${escapeHtml(new URLSearchParams({ ...(query ? { q: query } : {}), ...(post ? { post } : {}), ...(state ? { state } : {}), ...(decision ? { decision } : {}), after: listing.next }).toString())}">Continue</a></p>`
          : "";
      if (listing.rows.length === 0 && listing.next === undefined) {
        return `${form}${notes}<p class="empty">${query || post || state || decision ? "No saved judgments match this filter." : "No editorial judgments have been saved yet. This is not approval."}</p>`;
      }
      return `${form}${notes}<p>Each row is one saved judge attempt. A gated, malformed or failed judgment is never approval, and “revise” is a request for correction, not a publication decision.</p>
<div class="wrap"><table><thead><tr><th>Article</th><th>State</th><th>Decision</th><th>Gates</th><th>Judge</th><th>Decided</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };

  const view: DashboardView = {
    path: "/judgments/view",
    title: "Judgment",
    hidden: true,
    async render(url) {
      if (!judgments)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const path = url.searchParams.get("path") ?? "";
      const found = await judgments.detail(path);
      if (!found) return '<p class="empty">Choose a saved judgment from the list.</p>';
      const r: JudgmentRow = found.row;
      const facts: [string, string][] = [
        ["Article", `${escapeHtml(r.publicationId)}/${escapeHtml(r.postId)}`],
        ["State", badge(r.state)],
        ["Decision", decisionBadge(r.decision)],
        ["Judge model", r.judgeModel ? escapeHtml(r.judgeModel) : "not recorded"],
        ["Judge prompt", r.promptVersion ? `<code>${escapeHtml(r.promptVersion)}</code>` : "not recorded"],
        ["Decided", escapeHtml(r.decidedAt)],
        ["Assessment", `<code>${escapeHtml(found.assessmentPath)}</code>`],
        ["Reviewed body", `<code>${escapeHtml(found.bodyPath)}</code>`],
        ["Publication", `<code>${escapeHtml(found.publicationPath)}</code>`],
        ["Saved record", `<code>${escapeHtml(path)}</code>`],
      ];
      const gates = found.gates.length
        ? `<ul>${found.gates.map((g) => `<li><code>${escapeHtml(g)}</code></li>`).join("")}</ul>`
        : '<p class="empty">No deterministic gates blocked this judgment.</p>';
      const guidance = found.guidance
        ? `<h2>Reasons</h2><pre>${escapeHtml(found.guidance.reasons)}</pre>
<h2>Required corrections</h2><pre>${escapeHtml(found.guidance.requiredCorrections)}</pre>
<h2>Accepted minor observations</h2><pre>${escapeHtml(found.guidance.acceptedMinorObservations)}</pre>`
        : "";
      const document = found.documentUnreadable
        ? '<p class="empty">The retained judgment document could not be read.</p>'
        : found.document === undefined
          ? '<p class="empty">No judgment document was retained for this attempt.</p>'
          : `<h2>Retained judgment document</h2><pre>${escapeHtml(found.document)}</pre>`;
      return `<p><a href="/judgments">All judgments</a></p>
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<h2>Gate reasons</h2>${gates}
${guidance}
${found.guidance ? "" : document}`;
    },
  };
  return [list, view];
}
