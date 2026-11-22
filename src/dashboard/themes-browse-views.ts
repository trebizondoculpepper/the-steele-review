import type { GitArtifactStore } from "../controllers/artifact-store.js";
import {
  CollectionQueryError,
  collectionQueryFromParams,
  queryCollection,
} from "./collection-query.js";
import { escapeHtml, type DashboardView } from "./server.js";
import { themesCollection, type ThemeBrowseRow } from "./themes-collection.js";
import type { ThemesPort } from "./themes.js";

/**
 * Theme search (#618): canonical themes and extraction proposals through the
 * shared collection contract, as two separate lists. Read-only; it never
 * recomputes similarity or changes a mapping.
 */
export function themesBrowseViews(
  themes?: ThemesPort,
  content?: Pick<GitArtifactStore, "lookup" | "read">,
): DashboardView[] {
  const view: DashboardView = {
    path: "/themes/search",
    title: "Theme search",
    async render(url) {
      if (!themes || !content)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const raw = collectionQueryFromParams(url);
      const f = (raw.filters ?? {}) as Record<string, string>;
      const category = f.category === "proposal" ? "proposal" : "canonical";
      const q = (raw.text ?? "").slice(0, 200);
      const option = (name: string, value: string, label: string) =>
        `<option value="${value}"${f[name] === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const form = `<form method="get" action="/themes/search"><label>Text <input name="q" value="${escapeHtml(q)}" maxlength="200"></label> <label>List <select name="f.category">${option("category", "canonical", "canonical themes")}${option("category", "proposal", "extraction proposals")}</select></label> ${
        category === "canonical"
          ? `<label>Coverage <select name="f.coverage"><option value="">any</option>${option("coverage", "researched", "researched")}${option("coverage", "partially-researched", "partially researched")}${option("coverage", "unresearched", "unresearched")}</select></label>`
          : `<label>Mapping <select name="f.mapping"><option value="">any</option>${option("mapping", "mapped", "mapped")}${option("mapping", "unresolved", "unresolved")}${option("mapping", "unmapped", "unmapped")}</select></label>`
      } <button>Search</button></form>`;
      let page;
      try {
        page = await queryCollection(themesCollection(themes, content), raw);
      } catch (error) {
        if (error instanceof CollectionQueryError)
          return `${form}<p class="empty">That filter is not valid for theme search.</p>`;
        return `${form}<p class="empty">Saved themes are unavailable right now.</p>`;
      }
      const notes = page.limitations.map((l) => `<p class="empty">${escapeHtml(l)}</p>`).join("");
      const rows = (page.rows as ThemeBrowseRow[])
        .map((r) => {
          const version = `<code>${escapeHtml(`${r.artifact.commit.slice(0, 12)}:${r.artifact.path}`)}</code>`;
          if (r.category === "canonical") {
            const link = `/themes/canonical/view?${new URLSearchParams({ id: r.id }).toString()}`;
            return `<tr><td><a href="${escapeHtml(link)}">${escapeHtml(r.summary)}</a>${r.description ? `<br><span class="empty">${escapeHtml(r.description.slice(0, 200))}</span>` : ""}</td><td>${escapeHtml(r.coverage ?? "unknown")}</td><td>${version}</td></tr>`;
          }
          const link = `/themes/view?${new URLSearchParams({ result: r.result!, id: r.id.split("#")[1]! }).toString()}`;
          const mapping =
            r.mapping === "mapped" && r.mappedTheme
              ? `mapped to <a href="/themes/canonical/view?${escapeHtml(new URLSearchParams({ id: r.mappedTheme }).toString())}"><code>${escapeHtml(r.mappedTheme)}</code></a>`
              : escapeHtml(r.mapping ?? "unmapped");
          return `<tr><td><a href="${escapeHtml(link)}">${escapeHtml(r.summary)}</a>${r.description ? `<br><span class="empty">${escapeHtml(r.description.slice(0, 200))}</span>` : ""}</td><td>${escapeHtml(`${r.post!.publicationId}/${r.post!.postId}`)}</td><td>${mapping}</td><td>${version}</td></tr>`;
        })
        .join("");
      const params = new URLSearchParams(url.searchParams);
      params.delete("after");
      const next = page.next
        ? `<p><a href="/themes/search?${escapeHtml(new URLSearchParams([...params, ["after", page.next]]).toString())}">Continue</a></p>`
        : "";
      if (page.rows.length === 0)
        return `${form}${notes}<p class="empty">No ${category === "canonical" ? "canonical themes" : "proposals"} match this search.</p>${next}`;
      const head =
        category === "canonical"
          ? "<th>Canonical theme</th><th>Research coverage</th><th>Saved version</th>"
          : "<th>Proposal</th><th>Source post</th><th>Mapping</th><th>Saved extraction</th>";
      const note =
        category === "canonical"
          ? "Canonical themes are established topics; coverage reflects actual saved dossier evidence, and an unresearched theme is still a theme."
          : "Proposals are what extraction suggested for one post revision; a mapping is the librarian's saved decision, not similarity computed now.";
      return `${form}${notes}<p>${note}</p><div class="wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };
  return [view];
}
