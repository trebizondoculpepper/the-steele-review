import { escapeHtml, type DashboardView } from "./server.js";
import type { ThemesPort } from "./themes.js";
import type { ResearchPort } from "./research.js";
import { dossierPath } from "../research/dossier.js";

/**
 * Dedicated Dossiers section (#532).
 *
 * A dossier is the research collection for one established canonical theme.
 * This page lists only themes that actually have a saved dossier, and opening
 * one shows its exact pinned version, per-claim coverage, citations, gaps and
 * the associated saved documents. An unresearched theme is never presented as
 * an empty dossier; coverage is never promoted to verified evidence.
 */

const ID = /^[a-z0-9][a-z0-9-]{0,199}$/;

const stateBadge = (state: string) =>
  state === "researched"
    ? '<span class="s-done">researched</span>'
    : state === "partially-researched"
      ? '<span class="s-pending">partially researched</span>'
      : '<span class="s-pending">unresearched</span>';

export function dossierViews(themes?: ThemesPort, research?: ResearchPort): DashboardView[] {
  const list: DashboardView = {
    path: "/dossiers",
    title: "Dossiers",
    async render(url) {
      if (!themes)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const query = (url.searchParams.get("q") ?? "").slice(0, 200);
      const after = url.searchParams.get("after") ?? undefined;
      const listing = await themes.canonical({
        ...(query ? { query } : {}),
        ...(after ? { after } : {}),
      });
      if (listing.state === "unavailable")
        return '<p class="empty">Saved dossiers are unavailable right now.</p>';
      const withDossiers = listing.rows.filter((r) => r.dossier);
      const search = `<form method="get" action="/dossiers"><label>Filter dossiers <input name="q" value="${escapeHtml(query)}" maxlength="200"></label> <button>Filter</button></form>`;
      const rows = withDossiers
        .map((r) => {
          const dossier = r.dossier!;
          const link = `/dossiers/view?${new URLSearchParams({ theme: r.id }).toString()}`;
          return `<tr><td><a href="${escapeHtml(link)}">${escapeHtml(r.title)}</a><br><code>${escapeHtml(r.id)}</code></td><td>${stateBadge(r.state)}</td><td>${dossier.covered} covered / ${dossier.gaps} gap(s) / ${dossier.citations} citation(s)</td><td><code>${escapeHtml(dossier.commit.slice(0, 12))}</code></td></tr>`;
        })
        .join("");
      const notes = [
        listing.partial ? "This page reached its scan bound; continue to reach the rest." : "",
        listing.unreadable ? `${listing.unreadable} canonical theme(s) could not be read.` : "",
      ]
        .filter(Boolean)
        .map((n) => `<p class="empty">${escapeHtml(n)}</p>`)
        .join("");
      const next =
        listing.next !== undefined
          ? `<p><a href="/dossiers?${escapeHtml(new URLSearchParams({ ...(query ? { q: query } : {}), after: listing.next }).toString())}">Continue</a></p>`
          : "";
      if (withDossiers.length === 0) {
        return `${search}${notes}<p class="empty">${query ? "No saved dossiers match this filter." : "No research dossiers have been saved yet."} Established themes without research remain in <a href="/themes/catalogue">Themes</a>.</p>${next}`;
      }
      return `${search}${notes}<p>Research collections for established canonical themes. Themes without a dossier stay in <a href="/themes/catalogue">Themes</a>; proposals and mappings are separate.</p>
<div class="wrap"><table><thead><tr><th>Dossier theme</th><th>Research coverage</th><th>Contents</th><th>Version</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };

  const view: DashboardView = {
    path: "/dossiers/view",
    title: "Dossier",
    hidden: true,
    async render(url) {
      const id = url.searchParams.get("theme") ?? "";
      if (!themes || !research || !ID.test(id)) {
        return '<p class="empty">Choose a dossier from the list.</p>';
      }
      const canonical = await themes.canonicalDetail(id);
      if (!canonical) return '<p class="empty">Choose a dossier from the list.</p>';
      const { theme, coverage } = canonical;
      if (!coverage.dossier) {
        return `<p><a href="/dossiers">All dossiers</a> · <a href="/themes/canonical/view?id=${encodeURIComponent(theme.id)}">Theme</a></p>
<h1>${escapeHtml(theme.title)}</h1>
<p class="empty">This theme has no saved dossier yet, so there is no research collection to show. It is still an established canonical theme.</p>`;
      }
      const dossier = await research.detail(dossierPath(theme.id), coverage.dossier.commit);
      if (!dossier) {
        return `<p><a href="/dossiers">All dossiers</a></p><p class="empty">The saved dossier could not be read at its pinned version.</p>`;
      }
      const documents = await research
        .forTheme(theme.id, url.searchParams.get("after") ?? undefined)
        .catch(() => undefined);
      const claims = dossier.coverage?.length
        ? `<ul>${dossier.coverage
            .map(
              (c) =>
                `<li>${escapeHtml(c.claimId)} — ${
                  c.status === "covered"
                    ? `<span class="s-done">covered</span> (${c.citations
                        .map(
                          (x) =>
                            `<a href="#citation-${encodeURIComponent(x)}"><code>${escapeHtml(x)}</code></a>`,
                        )
                        .join(", ")})`
                    : `<span class="s-pending">gap</span>${c.reason ? `: ${escapeHtml(c.reason)}` : ""}`
                }</li>`,
            )
            .join("")}</ul>`
        : '<p class="empty">No claim coverage is recorded in this dossier.</p>';
      const citations = dossier.citations?.length
        ? `<div class="wrap"><table><thead><tr><th>Source</th><th>Passage</th></tr></thead><tbody>${dossier.citations
            .map(
              (c) =>
                `<tr id="citation-${escapeHtml(c.id ?? c.url)}"><td>${c.id ? `<code>${escapeHtml(c.id)}</code><br>` : ""}${escapeHtml(c.title ?? c.url)}<br><code>${escapeHtml(c.url)}</code></td><td><blockquote>${escapeHtml(c.passages.map((p) => p.passage).join(" … "))}</blockquote></td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : '<p class="empty">No citations are recorded.</p>';
      const gaps = dossier.gaps?.length
        ? `<ul>${dossier.gaps.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>`
        : '<p class="empty">No explicit gaps recorded.</p>';
      const documentList = documents?.docs.length
        ? `<ul>${documents.docs
            .map((d) => {
              const link = `/research/view?${new URLSearchParams({ path: d.path, at: d.commit }).toString()}`;
              return `<li><a href="${escapeHtml(link)}">${escapeHtml(d.title)}</a> <span class="empty">(${escapeHtml(d.kind)}${d.jobId ? `, ${escapeHtml(d.jobId)}` : ""})</span>${d.summary ? `<br>${escapeHtml(d.summary)}` : ""}</li>`;
            })
            .join("")}</ul>`
        : documents === undefined
          ? '<p class="empty">The document list is unavailable.</p>'
          : '<p class="empty">No other saved documents are associated with this theme.</p>';
      const documentNotes =
        documents === undefined
          ? ""
          : `${
              documents.state === "partial" || documents.truncated
                ? '<p class="empty">The document list is incomplete; later associations exist.</p>'
                : ""
            }${
              documents.next
                ? `<p><a href="/dossiers/view?${escapeHtml(new URLSearchParams({ theme: theme.id, after: documents.next }).toString())}">More documents</a></p>`
                : ""
            }`;
      return `<p><a href="/dossiers">All dossiers</a> · <a href="/themes/canonical/view?id=${encodeURIComponent(theme.id)}">Theme</a></p>
<h1>${escapeHtml(dossier.title)}</h1>
<p><code>${escapeHtml(theme.id)}</code> · ${stateBadge(coverage.state)}</p>
<p>Exact version <code>${escapeHtml(dossier.commit)}</code> · <code>${escapeHtml(dossier.hash.slice(0, 19))}…</code>${dossier.date ? ` · updated ${escapeHtml(dossier.date)}` : ""}</p>
${dossier.subject ? `<p>${escapeHtml(dossier.subject)}</p>` : ""}
<h2>Coverage</h2>${claims}
<h2>Citations</h2><p class="empty">Saved sources and quotations; a citation is not evidence that a claim is true.</p>${citations}
<h2>Gaps</h2>${gaps}
<h2>Associated documents</h2><p class="empty">Only saved theme/dossier associations are listed; imported and generated reports keep their recorded provenance.</p>${documentList}${documentNotes}
<h2>Dossier text</h2><pre>${escapeHtml(dossier.text)}</pre>`;
    },
  };
  return [list, view];
}
