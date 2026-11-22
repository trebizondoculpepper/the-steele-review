import type { ResearchPort } from "./research.js";
import { researchCollection, type ResearchBrowseRow } from "./research-collection.js";
import {
  CollectionQueryError,
  collectionQueryFromParams,
  queryCollection,
} from "./collection-query.js";
import { escapeHtml, type DashboardView } from "./server.js";

/**
 * Research browser (#620) on the shared collection contract: dossiers,
 * imported reports and generated reports remain distinct, every row carries
 * its exact version, and opening one uses the shared reader at that commit.
 */

const KIND_LABEL = {
  dossier: "dossier",
  "imported-report": "imported report",
  "generated-report": "generated report",
} as const;

export function researchBrowseViews(research?: ResearchPort): DashboardView[] {
  const list: DashboardView = {
    path: "/research/browse",
    title: "Research browser",
    async render(url) {
      if (!research)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const adapter = researchCollection(research);
      const raw = collectionQueryFromParams(url);
      const q = (raw.text ?? "").slice(0, 200);
      const f = (raw.filters ?? {}) as Record<string, string>;
      const option = (v: string, label: string) =>
        `<option value="${v}"${f.kind === v ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const form = `<form method="get" action="/research/browse"><label>Text <input name="q" value="${escapeHtml(q)}" maxlength="200"></label> <label>Kind <select name="f.kind"><option value="">any</option>${option("dossier", "dossier")}${option("imported-report", "imported report")}${option("generated-report", "generated report")}</select></label> <label>Subject <input name="f.subject" value="${escapeHtml(f.subject ?? "")}" maxlength="200"></label> <label>Dossier theme <input name="f.theme" value="${escapeHtml(f.theme ?? "")}" maxlength="100"></label> <input type="hidden" name="sort" value="stored"> <button>Search</button></form>`;
      let page;
      try {
        page = await queryCollection(adapter, raw);
      } catch (error) {
        if (error instanceof CollectionQueryError)
          return `${form}<p class="empty">That filter or sort is not valid for research documents.</p>`;
        return `${form}<p class="empty">Saved research documents are unavailable right now.</p>`;
      }
      const notes = page.limitations.map((l) => `<p class="empty">${escapeHtml(l)}</p>`).join("");
      const rows = (page.rows as ResearchBrowseRow[])
        .map((r) => {
          const read = `/research/view?${new URLSearchParams({ path: r.artifact.path, at: r.artifact.commit }).toString()}`;
          return `<tr><td><a href="${escapeHtml(read)}">${escapeHtml(r.summary)}</a></td><td>${escapeHtml(KIND_LABEL[r.kind])}</td><td>${r.subject ? escapeHtml(r.subject) : '<span class="empty">not recorded</span>'}</td><td>${r.date ? escapeHtml(r.date.slice(0, 10)) : '<span class="empty">not recorded</span>'}</td><td><code>${escapeHtml(r.artifact.commit.slice(0, 12))}</code><br><span class="empty">${escapeHtml(r.artifact.hash.slice(0, 19))}…</span></td></tr>`;
        })
        .join("");
      const params = new URLSearchParams(url.searchParams);
      params.delete("after");
      const next = page.next
        ? `<p><a href="/research/browse?${escapeHtml(new URLSearchParams([...params, ["after", page.next]]).toString())}">Continue</a></p>`
        : "";
      if (page.rows.length === 0) {
        const filtered = q || Object.values(f).some(Boolean);
        return `${form}${notes}<p class="empty">${filtered ? "No saved documents match this search." : "No research documents have been saved yet."}</p>${next}`;
      }
      return `${form}${notes}<p>Dossiers, imported reports and generated job reports are separate kinds and never promoted into each other. Rows are in the reader's stable stored order. Opening a row reads exactly the shown commit; a citation or summary is not evidence that a claim is true.</p>
<div class="wrap"><table><thead><tr><th>Document</th><th>Kind</th><th>Subject</th><th>Date</th><th>Version</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };
  return [list];
}
