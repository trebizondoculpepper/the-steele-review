import type { GitArtifactStore } from "../controllers/artifact-store.js";
import {
  CollectionQueryError,
  collectionQueryFromParams,
  queryCollection,
} from "./collection-query.js";
import { mappingDetail, themeMappingCollection, type MappingRow } from "./mappings.js";
import { escapeHtml, type DashboardView } from "./server.js";

/**
 * Theme mappings tab (#519). Read-only: it shows the librarian's saved
 * decisions, their method, reasons, provenance and exact versions, and never
 * edits, approves, recomputes or reclassifies anything.
 */

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;

const STATUS_CLASS = { resolved: "done", corrected: "pending", unresolved: "failed" } as const;
const badge = (status: keyof typeof STATUS_CLASS) =>
  `<span class="s-${STATUS_CLASS[status]}">${escapeHtml(status)}</span>`;

const themeLink = (id: string) =>
  `<a href="/themes/canonical/view?${escapeHtml(new URLSearchParams({ id }).toString())}"><code>${escapeHtml(id)}</code></a>`;

export function mappingViews(content?: Store): DashboardView[] {
  const list: DashboardView = {
    path: "/mappings",
    title: "Theme mappings",
    async render(url) {
      if (!content)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const adapter = themeMappingCollection(content);
      const raw = collectionQueryFromParams(url);
      const q = (raw.text ?? "").slice(0, 200);
      const f = (raw.filters ?? {}) as Record<string, string>;
      const sel = (name: string, options: string[], label: string) =>
        `<label>${label} <select name="f.${name}"><option value="">any</option>${options
          .map(
            (o) =>
              `<option value="${o}"${f[name] === o ? " selected" : ""}>${escapeHtml(o)}</option>`,
          )
          .join("")}</select></label>`;
      const form = `<form method="get" action="/mappings"><label>Text <input name="q" value="${escapeHtml(q)}" maxlength="200"></label> <label>Theme ID <input name="f.theme" value="${escapeHtml(f.theme ?? "")}" maxlength="100"></label> ${sel("status", ["resolved", "corrected", "unresolved"], "Status")} ${sel("method", ["embedding", "lexical", "manual", "unrecorded"], "Method")} <label>Sort <select name="sort"><option value="decided"${raw.sort === "proposal" ? "" : " selected"}>decided</option><option value="proposal"${raw.sort === "proposal" ? " selected" : ""}>proposal</option></select></label> <button>Filter</button></form>`;
      let page;
      try {
        page = await queryCollection(adapter, raw);
      } catch (error) {
        if (error instanceof CollectionQueryError)
          return `${form}<p class="empty">That filter is not valid for theme mappings.</p>`;
        return `${form}<p class="empty">Saved theme mappings are unavailable right now.</p>`;
      }
      const notes = page.limitations.map((l) => `<p class="empty">${escapeHtml(l)}</p>`).join("");
      const rows = (page.rows as MappingRow[])
        .map((r) => {
          const m = r.mapping;
          const detail = `/mappings/view?${new URLSearchParams({ path: r.id }).toString()}`;
          return `<tr><td><a href="${escapeHtml(detail)}">${escapeHtml(m.proposal)}</a>${m.description ? `<br><span class="empty">${escapeHtml(m.description.slice(0, 200))}</span>` : ""}</td><td>${m.scope ? escapeHtml(m.scope) : '<span class="empty">global</span>'}</td><td>${themeLink(m.canonicalThemeId)}</td><td>${badge(r.status)}</td><td>${escapeHtml(m.method ?? "not recorded")}</td><td>${escapeHtml(m.decidedAt.slice(0, 10))}</td></tr>`;
        })
        .join("");
      const params = new URLSearchParams(url.searchParams);
      params.delete("after");
      const next = page.next
        ? `<p><a href="/mappings?${escapeHtml(new URLSearchParams([...params, ["after", page.next]]).toString())}">Continue</a></p>`
        : "";
      if (page.rows.length === 0) {
        const filtered = q || Object.values(f).some(Boolean);
        return `${form}${notes}<p class="empty">${filtered ? "No saved mappings match this filter." : "No theme mappings have been saved yet."}</p>`;
      }
      return `${form}${notes}<p>Recorded librarian decisions mapping proposed theme wording to canonical themes. Wording and description together identify a mapping, so the same title with a different meaning is a separate mapping. A mapping says where research is filed, not that any claim is true.</p>
<div class="wrap"><table><thead><tr><th>Proposed wording</th><th>Scope</th><th>Canonical theme</th><th>Status</th><th>Method</th><th>Decided</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };

  const view: DashboardView = {
    path: "/mappings/view",
    title: "Theme mapping",
    hidden: true,
    async render(url) {
      if (!content)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const path = url.searchParams.get("path") ?? "";
      const commit = url.searchParams.get("commit");
      const sha = url.searchParams.get("sha256");
      const repo = url.searchParams.get("repository");
      const pinned = commit && sha && repo ? { repository: repo, commit, sha256: sha } : undefined;
      const found = await mappingDetail(content, path, pinned);
      if (!found)
        return '<p class="empty">Choose a saved mapping from the list, or the pinned version could not be read exactly.</p>';
      const m = found.mapping;
      const sourceLink = m.source
        ? `<a href="/themes/view?${escapeHtml(new URLSearchParams({ result: m.source.themeResult.path, id: m.source.proposalId }).toString())}">proposal <code>${escapeHtml(m.source.proposalId)}</code></a> in <code>${escapeHtml(`${m.source.themeResult.commit.slice(0, 12)}:${m.source.themeResult.path}`)}</code>`
        : '<span class="empty">not recorded (mapping saved before provenance was kept)</span>';
      const facts: [string, string][] = [
        ["Proposed wording", escapeHtml(m.proposal)],
        [
          "Description",
          m.description ? escapeHtml(m.description) : '<span class="empty">none</span>',
        ],
        ["Scope", m.scope ? escapeHtml(m.scope) : "global"],
        ["Canonical theme", themeLink(m.canonicalThemeId)],
        ["Status", badge(found.status)],
        ["Method", escapeHtml(m.method ?? "not recorded")],
        ["Rationale", escapeHtml(m.rationale)],
        [
          "Decided",
          `${escapeHtml(m.decidedAt)} by <code>${escapeHtml(`${m.decidedBy.publicationId}/${m.decidedBy.postId}`)}</code>`,
        ],
        ["Source occurrence", sourceLink],
        ...(m.correction
          ? ([
              [
                "Latest correction",
                `${escapeHtml(m.correction.reason)} (${escapeHtml(m.correction.correctedAt)})`,
              ],
            ] as [string, string][])
          : []),
        [
          pinned ? "Pinned version" : "Current version",
          `<code>${escapeHtml(`${found.current.commit.slice(0, 12)}:${found.current.path}`)}</code> <span class="empty">sha256:${escapeHtml(found.current.sha256.slice(0, 16))}…</span>`,
        ],
      ];
      const unresolved =
        found.status === "unresolved"
          ? '<p class="empty">This mapping is unresolved: it is not reused, and the next proposal with this wording goes back through the bounded decision path.</p>'
          : "";
      const history = pinned
        ? `<p><a href="/mappings/view?${escapeHtml(new URLSearchParams({ path }).toString())}">Show the current version</a></p>`
        : '<p class="empty">Corrections are normal revisions of this file; earlier briefs keep reading the exact version they pinned.</p>';
      return `<p><a href="/mappings">All theme mappings</a> · <a href="/mappings?${escapeHtml(new URLSearchParams({ "f.theme": m.canonicalThemeId }).toString())}">Other wording mapped to this theme</a></p>${unresolved}
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>${history}`;
    },
  };
  return [list, view];
}
