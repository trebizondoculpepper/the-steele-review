import { escapeHtml, type DashboardView } from "./server.js";
import type { ThemesPort } from "./themes.js";

/** Read-only Themes pages (#493). */

const traceLink = (publicationId: string, postId: string) =>
  `/articles/trace?${new URLSearchParams({ publication: publicationId, post: postId }).toString()}`;
const detailLink = (result: string, id: string) =>
  `/themes/view?${new URLSearchParams({ result, id }).toString()}`;

export function themeViews(themes?: ThemesPort): DashboardView[] {
  const list: DashboardView = {
    path: "/themes",
    title: "Themes",
    async render(url) {
      if (!themes)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const query = (url.searchParams.get("q") ?? "").slice(0, 200);
      const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
      const listing = await themes.list({ query, offset });
      const search = `<form method="get" action="/themes"><label>Filter titles and descriptions <input name="q" value="${escapeHtml(query)}" maxlength="200"></label> <button>Filter</button></form>`;
      if (listing.state === "unavailable") {
        return `${search}<p class="empty">Saved themes are unavailable right now.</p>`;
      }
      const notes = [
        listing.partial
          ? "Only the first saved extractions were scanned; results may be incomplete."
          : "",
        listing.unreadable ? `${listing.unreadable} saved extraction(s) could not be read.` : "",
      ]
        .filter(Boolean)
        .map((n) => `<p class="empty">${escapeHtml(n)}</p>`)
        .join("");
      if (listing.rows.length === 0) {
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
          ? `<p><a href="/themes?${escapeHtml(new URLSearchParams({ ...(query ? { q: query } : {}), offset: String(listing.next) }).toString())}">Next page</a></p>`
          : "";
      return `${search}${notes}<p>Extractor proposals, one per saved post extraction. Similar titles from different posts stay separate; they are not canonical themes. <a href="/themes/catalogue">Canonical catalogue</a></p>
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

  const catalogue: DashboardView = {
    path: "/themes/catalogue",
    title: "Canonical themes",
    hidden: true,
    async render() {
      if (!themes)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const c = await themes.catalogue();
      if (c.state === "unavailable")
        return '<p class="empty">The canonical catalogue is unavailable right now.</p>';
      if (c.themes.length === 0)
        return '<p class="empty">No canonical catalogue has been saved.</p>';
      return `<p><a href="/themes">All extractor proposals</a></p><p>Librarian-owned canonical themes.</p>
<div class="wrap"><table><thead><tr><th>Name</th><th>Definition</th><th>Origin</th><th>Aliases</th></tr></thead><tbody>${c.themes
        .map(
          (t) =>
            `<tr><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.definition)}</td><td>${escapeHtml(t.origin)}</td><td>${escapeHtml(t.aliases.join(", "))}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
    },
  };
  return [list, detail, catalogue];
}
