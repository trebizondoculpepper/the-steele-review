import { proposalMappingKey, themeMappingPath } from "../research/theme-mappings.js";
import { escapeHtml, type DashboardView } from "./server.js";
import type { ThemesPort } from "./themes.js";
import type { ResearchPort, ThemeResearchDoc } from "./research.js";
import type { ResearchState } from "../research/theme-coverage.js";
import { dossierPath } from "../research/dossier.js";

/** Read-only Themes pages (#493). */

const traceLink = (publicationId: string, postId: string) =>
  `/articles/trace?${new URLSearchParams({ publication: publicationId, post: postId }).toString()}`;
const detailLink = (result: string, id: string) =>
  `/themes/view?${new URLSearchParams({ result, id }).toString()}`;

export function themeViews(themes?: ThemesPort, research?: ResearchPort): DashboardView[] {
  const list: DashboardView = {
    path: "/themes",
    title: "Themes",
    async render(url) {
      if (!themes)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const query = (url.searchParams.get("q") ?? "").slice(0, 200);
      const after = url.searchParams.get("after") ?? undefined;
      const listing = await themes.list({ query, ...(after ? { after } : {}) });
      const search = `<form method="get" action="/themes"><label>Filter titles and descriptions <input name="q" value="${escapeHtml(query)}" maxlength="200"></label> <button>Filter</button></form>`;
      if (listing.state === "unavailable") {
        return `${search}<p class="empty">Saved themes are unavailable right now.</p>`;
      }
      const notes = [
        listing.partial
          ? "This page reached its scan bound before finding a full page of matches; continue to scan further."
          : "",
        listing.unreadable ? `${listing.unreadable} saved extraction(s) could not be read.` : "",
      ]
        .filter(Boolean)
        .map((n) => `<p class="empty">${escapeHtml(n)}</p>`)
        .join("");
      if (listing.rows.length === 0 && listing.next === undefined) {
        return `${search}${notes}<p class="empty">${query ? "No saved themes match this filter." : "No saved themes yet."}</p>`;
      }
      const rows = listing.rows
        .map(
          (r) =>
            `<tr><td><a href="${escapeHtml(detailLink(r.result, r.id))}">${escapeHtml(r.title)}</a></td><td>${r.description ? escapeHtml(r.description) : '<span class="empty">no description saved</span>'}</td><td><a href="${escapeHtml(traceLink(r.publicationId, r.postId))}">${escapeHtml(r.postId)}</a></td><td>${escapeHtml(r.proposedAt.slice(0, 10))}</td></tr>`,
        )
        .join("");
      const next =
        listing.next !== undefined
          ? `<p><a href="/themes?${escapeHtml(new URLSearchParams({ ...(query ? { q: query } : {}), after: listing.next }).toString())}">Continue</a> — saved extractions are listed in storage order, a page at a time.</p>`
          : "<p>End of the saved extractions.</p>";
      return `${search}${notes}<p>Extractor proposals, one per saved post extraction. Similar titles from different posts stay separate; they are not canonical themes. <a href="/themes/catalogue">Canonical themes</a></p>
<div class="wrap"><table><thead><tr><th>Title</th><th>Description</th><th>Post</th><th>Extracted</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };

  const detail: DashboardView = {
    path: "/themes/view",
    title: "Theme",
    hidden: true,
    async render(url) {
      if (!themes)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const found = await themes.detail(
        url.searchParams.get("result") ?? "",
        url.searchParams.get("id") ?? "",
      );
      if (!found) return '<p class="empty">Choose a theme from the list.</p>';
      const r = found.row;
      const facts: [string, string][] = [
        ["Title", escapeHtml(r.title)],
        [
          "Description",
          r.description
            ? escapeHtml(r.description)
            : '<span class="empty">no description saved</span>',
        ],
        [
          "Source post",
          `<a href="${escapeHtml(traceLink(r.publicationId, r.postId))}">${escapeHtml(`${r.publicationId}/${r.postId}`)}</a>`,
        ],
        ["Source revision", `<code>${escapeHtml(r.sourceVersion)}</code>`],
        [
          "Saved mapping",
          // The exact mapping record this wording would use (#519); the
          // detail page says so when no decision has been saved yet.
          `<a href="/mappings/view?${escapeHtml(
            new URLSearchParams({
              path: themeMappingPath({ key: proposalMappingKey(r.title, r.description) }),
            }).toString(),
          )}">open the librarian's mapping for this wording</a>`,
        ],
        [
          "Extraction",
          `${escapeHtml(r.modelVersion)} · <code>${escapeHtml(r.promptVersion)}</code> · ${escapeHtml(r.proposedAt)}`,
        ],
        ["Rejected candidates in this extraction", String(r.rejectedInResult)],
      ];
      const claims = found.claims.length
        ? `<ul>${found.claims.map((c) => `<li>${escapeHtml(c.statement)}</li>`).join("")}</ul>`
        : '<p class="empty">No claims from this extraction link to this proposal.</p>';
      return `<p><a href="/themes">All themes</a></p>
<p class="empty">An extractor proposal for one post revision, not a canonical theme.</p>
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<h2>Linked claim proposals</h2>${found.claimsPartial ? '<p class="empty">The claim scan was incomplete.</p>' : ""}${claims}`;
    },
  };

  const coverageOptions: Array<{ value: string; label: string }> = [
    { value: "", label: "All research coverage" },
    { value: "unresearched", label: "Unresearched" },
    { value: "partially-researched", label: "Partially researched" },
    { value: "researched", label: "Researched" },
  ];
  const coverageParam = (url: URL): ResearchState | undefined => {
    const raw = url.searchParams.get("coverage") ?? "";
    return raw === "unresearched" || raw === "partially-researched" || raw === "researched"
      ? raw
      : undefined;
  };

  const expressCoverage = (state: ResearchState) =>
    state === "unresearched"
      ? '<span class="s-pending">unresearched</span>'
      : state === "partially-researched"
        ? '<span class="s-pending">partially researched</span>'
        : '<span class="s-done">researched</span>';

  const catalogue: DashboardView = {
    path: "/themes/catalogue",
    title: "Canonical themes",
    hidden: true,
    async render(url) {
      if (!themes)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const query = (url.searchParams.get("q") ?? "").slice(0, 200);
      const coverage = coverageParam(url);
      const after = url.searchParams.get("after") ?? undefined;
      const listing = await themes.canonical({
        ...(query ? { query } : {}),
        ...(coverage ? { coverage } : {}),
        ...(after ? { after } : {}),
      });
      const form = `<form method="get" action="/themes/catalogue"><label>Filter titles and descriptions <input name="q" value="${escapeHtml(query)}" maxlength="200"></label> <label>Coverage <select name="coverage">${coverageOptions
        .map(
          (o) =>
            `<option value="${o.value}"${(coverage ?? "") === o.value ? " selected" : ""}>${o.label}</option>`,
        )
        .join("")}</select></label> <button>Filter</button></form>`;
      if (listing.state === "unavailable")
        return `${form}<p class="empty">Canonical themes are unavailable right now.</p>`;
      const notes = [
        listing.partial
          ? "This page reached its scan bound; continue to reach the rest of the catalogue."
          : "",
        listing.unreadable ? `${listing.unreadable} canonical theme(s) could not be read.` : "",
      ]
        .filter(Boolean)
        .map((n) => `<p class="empty">${escapeHtml(n)}</p>`)
        .join("");
      if (listing.rows.length === 0 && listing.next === undefined) {
        return `${form}${notes}<p class="empty">${query || coverage ? "No canonical themes match this filter." : "No canonical themes have been established yet. The earlier detected catalogue is still available."}</p>${query || coverage ? "" : '<p><a href="/themes/catalogue/legacy">Legacy detected catalogue</a></p>'}`;
      }
      const rows = listing.rows
        .map((r) => {
          const link = `/themes/canonical/view?${new URLSearchParams({ id: r.id }).toString()}`;
          const research = r.dossier
            ? `${expressCoverage(r.state)} · ${r.dossier.covered} covered / ${r.dossier.gaps} gap(s)`
            : `${expressCoverage(r.state)} · <span class="empty">no research yet</span>`;
          return `<tr><td><a href="${escapeHtml(link)}">${escapeHtml(r.title)}</a><br><code>${escapeHtml(r.id)}</code></td><td>${r.description ? escapeHtml(r.description) : '<span class="empty">no description saved</span>'}</td><td>${research}</td></tr>`;
        })
        .join("");
      const params = new URLSearchParams({
        ...(query ? { q: query } : {}),
        ...(coverage ? { coverage } : {}),
        ...(listing.next ? { after: listing.next } : {}),
      });
      const next =
        listing.next !== undefined
          ? `<p><a href="/themes/catalogue?${escapeHtml(params.toString())}">Continue</a></p>`
          : "<p>End of the canonical catalogue.</p>";
      return `${form}${notes}<p>Librarian-established canonical topics, including those with no research yet. <a href="/themes">Extractor proposals</a></p>
<div class="wrap"><table><thead><tr><th>Canonical theme</th><th>Description</th><th>Research coverage</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };

  const canonicalDetail: DashboardView = {
    path: "/themes/canonical/view",
    title: "Canonical theme",
    hidden: true,
    async render(url) {
      if (!themes)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const id = url.searchParams.get("id") ?? "";
      const found = await themes.canonicalDetail(id);
      if (!found) return '<p class="empty">Choose a canonical theme from the catalogue.</p>';
      const { theme, coverage } = found;
      const dossier = coverage.dossier;
      const researchSummary = dossier
        ? `<p>${expressCoverage(coverage.state)} — ${dossier.covered} covered claim(s), ${dossier.gaps} gap(s), ${dossier.citations} citation(s).</p>
<p><a href="/research/view?${escapeHtml(new URLSearchParams({ path: dossierPath(theme.id), at: dossier.commit }).toString())}">Read the research documents</a> · dossier <code>${escapeHtml(dossier.hash.slice(0, 19))}…</code></p>`
        : `<p>${expressCoverage(coverage.state)} — no research has been saved for this theme yet. It still exists as an established topic.</p>`;
      const mapped = found.proposals.length
        ? `<div class="wrap"><table><thead><tr><th>Proposal wording</th><th>Scope</th><th>Decided</th><th>Provenance</th></tr></thead><tbody>${found.proposals
            .map(
              (p) =>
                `<tr><td>${escapeHtml(p.proposal)}${p.description ? `<br><span class="empty">${escapeHtml(p.description)}</span>` : ""}</td><td>${p.scope ? escapeHtml(p.scope) : '<span class="empty">global</span>'}</td><td>${escapeHtml(p.decidedAt.slice(0, 10))}</td><td>${escapeHtml(p.decidedBy.publicationId)}/${escapeHtml(p.decidedBy.postId)}<br><span class="empty">${escapeHtml(p.rationale)}</span></td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : '<p class="empty">No saved librarian mapping targets this theme yet.</p>';
      let documents: ThemeResearchDoc[] = [];
      let documentsState = "unavailable" as "ok" | "none" | "partial" | "unavailable";
      let documentsNext: string | undefined;
      if (research) {
        try {
          const listing = await research.forTheme(
            theme.id,
            url.searchParams.get("after") ?? undefined,
          );
          documents = listing.docs;
          documentsState = listing.state;
          documentsNext = listing.next;
        } catch {
          documentsState = "unavailable";
        }
      }
      const documentRows = documents
        .map((d) => {
          const link = `/research/view?${new URLSearchParams({ path: d.path, at: d.commit }).toString()}`;
          return `<tr><td><a href="${escapeHtml(link)}">${escapeHtml(d.title)}</a>${d.jobId ? `<br><code>${escapeHtml(d.jobId)}</code>` : ""}</td><td>${escapeHtml(d.kind)}</td><td>${d.summary ? escapeHtml(d.summary) : '<span class="empty">no summary saved</span>'}</td><td>${d.date ? escapeHtml(d.date) : '<span class="empty">no date recorded</span>'}</td><td><code>${escapeHtml(d.commit.slice(0, 12))}</code><br><span class="empty">${escapeHtml(d.hash.slice(0, 19))}…</span></td></tr>`;
        })
        .join("");
      const documentsNote =
        documentsState === "unavailable"
          ? '<p class="empty">Saved research documents are unavailable.</p>'
          : documentsState === "none"
            ? '<p class="empty">No saved research documents are linked to this theme yet. Browse the <a href="/research">Research browser</a> for unrelated material.</p>'
            : documentsState === "partial"
              ? '<p class="empty">This document list is incomplete; open the <a href="/research">Research browser</a> to search the corpus.</p>'
              : "";
      const moreDocuments = documentsNext
        ? `<p><a href="/themes/canonical/view?${escapeHtml(new URLSearchParams({ id: theme.id, after: documentsNext }).toString())}">More documents</a></p>`
        : "";
      const documentsSection = `<h2>Research documents</h2><p class="empty">Only saved librarian/theme/dossier associations are listed; documents are never matched by title.</p>${documentsState === "unavailable" ? "" : `<div class="wrap"><table><thead><tr><th>Document</th><th>Kind</th><th>Summary</th><th>Date</th><th>Version</th></tr></thead><tbody>${documentRows}</tbody></table></div>`}${documentsNote}${moreDocuments}`;
      return `<p><a href="/themes/catalogue">All canonical themes</a> · <a href="/themes">Extractor proposals</a></p>
<h1>${escapeHtml(theme.title)}</h1>
<p><code>${escapeHtml(theme.id)}</code></p>
${theme.description ? `<p>${escapeHtml(theme.description)}</p>` : ""}
<h2>Research</h2>${researchSummary}
${documentsSection}
<h2>Mapped proposal wording</h2><p class="empty">Proposals remain distinct; this is the librarian's saved mapping, not UI string merging.</p>${found.proposalsPartial ? '<p class="empty">The mapping scan was incomplete.</p>' : ""}${mapped}`;
    },
  };
  const legacyCatalogue: DashboardView = {
    path: "/themes/catalogue/legacy",
    title: "Legacy detected catalogue",
    hidden: true,
    async render() {
      if (!themes)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const c = await themes.catalogue();
      if (c.state === "unavailable")
        return '<p class="empty">The legacy catalogue is unavailable right now.</p>';
      if (c.themes.length === 0)
        return '<p><a href="/themes/catalogue">Canonical themes</a></p><p class="empty">No legacy catalogue has been saved.</p>';
      return `<p><a href="/themes/catalogue">Canonical themes</a></p><p class="empty">The earlier detected catalogue, kept readable while canonical identities are established; it is not the librarian's canonical authority.</p>
<div class="wrap"><table><thead><tr><th>Name</th><th>Definition</th><th>Origin</th><th>Aliases</th></tr></thead><tbody>${c.themes
        .map(
          (t) =>
            `<tr><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.definition)}</td><td>${escapeHtml(t.origin)}</td><td>${escapeHtml(t.aliases.join(", "))}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
    },
  };
  return [list, detail, catalogue, canonicalDetail, legacyCatalogue];
}
