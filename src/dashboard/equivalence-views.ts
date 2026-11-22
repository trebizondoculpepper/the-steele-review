import { escapeHtml, type DashboardView } from "./server.js";
import type { EquivalencePort, EquivalenceRow } from "./equivalence.js";

/**
 * Claim-equivalence browser (#616). Shows saved decisions and their reasons;
 * it never recomputes similarity, merges claims or judges truth.
 */

const LOSS = { equivalent: "done", separate: "pending" } as const;
const badge = (outcome: string) =>
  `<span class="s-${LOSS[outcome as keyof typeof LOSS] ?? "pending"}">${escapeHtml(outcome)}</span>`;

export function equivalenceViews(equivalence?: EquivalencePort): DashboardView[] {
  const list: DashboardView = {
    path: "/equivalence",
    title: "Claim equivalence",
    async render(url) {
      if (!equivalence)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const query = (url.searchParams.get("q") ?? "").slice(0, 200);
      const outcomeRaw = url.searchParams.get("outcome") ?? "";
      const outcome =
        outcomeRaw === "equivalent" || outcomeRaw === "separate" ? outcomeRaw : undefined;
      const after = url.searchParams.get("after") ?? undefined;
      const listing = await equivalence.list({
        ...(query ? { query } : {}),
        ...(outcome ? { outcome } : {}),
        ...(after ? { after } : {}),
      });
      const form = `<form method="get" action="/equivalence"><label>Text <input name="q" value="${escapeHtml(query)}" maxlength="200"></label> <label>Outcome <select name="outcome"><option value=""${outcome ? "" : " selected"}>all</option><option value="equivalent"${outcome === "equivalent" ? " selected" : ""}>matched equivalent</option><option value="separate"${outcome === "separate" ? " selected" : ""}>kept separate</option></select></label> <button>Filter</button></form>`;
      if (listing.state === "unavailable")
        return `${form}<p class="empty">Saved equivalence decisions are unavailable right now.</p>`;
      const notes = [
        listing.partial ? "This page reached its scan bound; continue to see later decisions." : "",
        listing.unreadable ? `${listing.unreadable} saved decision(s) could not be read.` : "",
      ]
        .filter(Boolean)
        .map((n) => `<p class="empty">${escapeHtml(n)}</p>`)
        .join("");
      const rows = listing.rows
        .map((r) => {
          const link = `/equivalence/view?${new URLSearchParams({ path: r.path }).toString()}`;
          return `<tr><td><a href="${escapeHtml(link)}">${escapeHtml(r.statement)}</a></td><td>${badge(r.outcome)}</td><td>${r.match ? `<code>${escapeHtml(r.match)}</code>` : '<span class="empty">no canonical claim</span>'}</td><td>${escapeHtml(r.confidence ?? "not recorded")}</td><td>${escapeHtml(r.decidedAt.slice(0, 10))}</td></tr>`;
        })
        .join("");
      const next =
        listing.next !== undefined
          ? `<p><a href="/equivalence?${escapeHtml(new URLSearchParams({ ...(query ? { q: query } : {}), ...(outcome ? { outcome } : {}), after: listing.next }).toString())}">Continue</a></p>`
          : "";
      if (listing.rows.length === 0 && listing.next === undefined) {
        return `${form}${notes}<p class="empty">${query || outcome ? "No saved decisions match this filter." : "No claim-equivalence decisions have been saved yet."}</p>`;
      }
      return `${form}${notes}<p>Recorded librarian decisions about whether two statements assert the same thing. A match is not evidence that either claim is true.</p>
<div class="wrap"><table><thead><tr><th>Statement</th><th>Outcome</th><th>Matched claim</th><th>Confidence</th><th>Decided</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };

  const view: DashboardView = {
    path: "/equivalence/view",
    title: "Equivalence decision",
    hidden: true,
    async render(url) {
      if (!equivalence)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const path = url.searchParams.get("path") ?? "";
      const found = await equivalence.detail(path);
      if (!found) return '<p class="empty">Choose a saved decision from the list.</p>';
      const r: EquivalenceRow = found.row;
      const claimsLink = `/claims?${new URLSearchParams({ q: r.statement.slice(0, 100) }).toString()}`;
      const facts: [string, string][] = [
        ["Recorded statement", escapeHtml(r.statement)],
        ["Outcome", badge(r.outcome)],
        ["Matched claim", r.match ? `<code>${escapeHtml(r.match)}</code>` : "kept separate (no match recorded)"],
        ["Confidence", escapeHtml(r.confidence ?? "not recorded (legacy or separate)")],
        ["Reason", escapeHtml(r.reason)],
        ["Model", escapeHtml(r.modelVersion)],
        ["Prompt", `<code>${escapeHtml(r.promptVersion)}</code>`],
        ["Decided", escapeHtml(r.decidedAt)],
        ["Saved record", `<code>${escapeHtml(path)}</code>`],
        ...(found.canonical
          ? ([["Current canonical claim", `<code>${escapeHtml(found.canonical)}</code>`]] as [string, string][])
          : []),
      ];
      const candidates = r.candidates.length
        ? `<ul>${r.candidates
            .map(
              (c) =>
                `<li><code>${escapeHtml(c.id)}</code> — <a href="/claims?${escapeHtml(new URLSearchParams({ q: c.statement.slice(0, 100) }).toString())}">${escapeHtml(c.statement)}</a></li>`,
            )
            .join("")}</ul>`
        : '<p class="empty">No candidate claims were offered for this decision.</p>';
      const occurrences = found.occurrences.length
        ? `<div class="wrap"><table><thead><tr><th>Post</th><th>Passage</th><th>Occurrence</th></tr></thead><tbody>${found.occurrences
            .map(
              (o) =>
                `<tr><td><a href="/articles/trace?${escapeHtml(new URLSearchParams({ publication: o.publicationId, post: o.postId }).toString())}">${escapeHtml(o.publicationId)}/${escapeHtml(o.postId)}</a></td><td>${o.passage === undefined ? '<span class="empty">passage not recorded</span>' : `<blockquote>${escapeHtml(o.passage)}</blockquote>`}</td><td>${o.occurrenceId ? `<code>${escapeHtml(o.occurrenceId)}</code>` : '<span class="empty">not recorded</span>'}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : '<p class="empty">No saved occurrences are recorded for this claim.</p>';
      return `<p><a href="/equivalence">All equivalence decisions</a> · <a href="${escapeHtml(claimsLink)}">Claims matching this statement</a></p>
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<h2>Candidate claims</h2><p class="empty">Only the candidates saved with this decision are shown; no new comparison is run.</p>${candidates}
<h2>Occurrences</h2>${found.occurrencesPartial ? '<p class="empty">Some occurrences could not be read or the list was truncated.</p>' : ""}${occurrences}`;
    },
  };
  return [list, view];
}
