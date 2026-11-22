import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { articlesCollection, type ArticleBrowseRow } from "./articles-collection.js";
import {
  CollectionQueryError,
  collectionQueryFromParams,
  queryCollection,
} from "./collection-query.js";
import type { DraftInventoryPort } from "./drafts.js";
import { escapeHtml, type DashboardView } from "./server.js";

/**
 * Article search (#621): logical articles at their current version, with the
 * exact approval state, and history one click away. Read-only.
 */

const LABEL: Record<ArticleBrowseRow["approval"], string> = {
  approved: "approved",
  "body-only-approved": "body approved; title/subtitle/excerpt not approved",
  redraft: "redraft required",
  unverified: "not verified",
  incomplete: "verification status incomplete",
  unreadable: "unreadable",
};

export function articlesBrowseViews(
  drafts?: DraftInventoryPort,
  content?: Pick<GitArtifactStore, "lookup">,
): DashboardView[] {
  const view: DashboardView = {
    path: "/drafts/search",
    title: "Article search",
    async render(url) {
      if (!drafts || !content)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const raw = collectionQueryFromParams(url);
      const f = (raw.filters ?? {}) as Record<string, string>;
      const category = f.category === "legacy-draft" ? "legacy-draft" : "article";
      const q = (raw.text ?? "").slice(0, 200);
      const opt = (name: string, value: string, label: string) =>
        `<option value="${value}"${f[name] === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const form = `<form method="get" action="/drafts/search"><label>Text <input name="q" value="${escapeHtml(q)}" maxlength="200"></label> <label>List <select name="f.category">${opt("category", "article", "logical articles")}${opt("category", "legacy-draft", "drafts before logical articles")}</select></label> <label>Approval <select name="f.approval"><option value="">any</option>${Object.entries(
        LABEL,
      )
        .map(([v, l]) => opt("approval", v, l))
        .join(
          "",
        )}</select></label> <label>Publication <input name="f.publication" value="${escapeHtml(f.publication ?? "")}" maxlength="300"></label> <button>Search</button></form>`;
      let page;
      try {
        page = await queryCollection(articlesCollection(drafts, content), raw);
      } catch (error) {
        if (error instanceof CollectionQueryError)
          return `${form}<p class="empty">That filter is not valid for article search.</p>`;
        return `${form}<p class="empty">Saved articles are unavailable right now.</p>`;
      }
      const notes = page.limitations.map((l) => `<p class="empty">${escapeHtml(l)}</p>`).join("");
      const rows = (page.rows as ArticleBrowseRow[])
        .map((r) => {
          const view = `/drafts/view?${new URLSearchParams({ path: r.artifact.path }).toString()}`;
          const history = r.article
            ? ` · <a href="/drafts/article?${escapeHtml(new URLSearchParams({ publication: r.publicationId, post: r.postId, id: r.article.id }).toString())}">version ${r.article.version} history</a>`
            : "";
          return `<tr><td><a href="${escapeHtml(view)}">${escapeHtml(r.summary)}</a>${r.subtitle ? `<br><span class="empty">${escapeHtml(r.subtitle)}</span>` : ""}${history}</td><td>${escapeHtml(`${r.publicationId}/${r.postId}`)}</td><td>${escapeHtml(LABEL[r.approval])}${r.limitations?.length ? `<br><span class="empty">${escapeHtml(r.limitations.join("; "))}</span>` : ""}</td><td><code>${escapeHtml(`${r.artifact.commit.slice(0, 12)}:${r.artifact.path}`)}</code></td></tr>`;
        })
        .join("");
      const params = new URLSearchParams(url.searchParams);
      params.delete("after");
      const next = page.next
        ? `<p><a href="/drafts/search?${escapeHtml(new URLSearchParams([...params, ["after", page.next]]).toString())}">Continue</a></p>`
        : "";
      if (page.rows.length === 0)
        return `${form}${notes}<p class="empty">No ${category === "article" ? "logical articles" : "earlier drafts"} on this page match the search.</p>${next}`;
      return `${form}${notes}<p>One row per logical article at its current version; earlier versions are in each article's history. Approval is exact: a body-only approval does not cover changed title, subtitle or excerpt.</p><div class="wrap"><table><thead><tr><th>Article</th><th>Post</th><th>Approval</th><th>Saved version</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };
  return [view];
}
