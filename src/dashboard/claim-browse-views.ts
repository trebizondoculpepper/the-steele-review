import type { ClaimsPort } from "./claims.js";
import { claimCollection, type ClaimBrowseRow } from "./claim-collection.js";
import {
  CollectionQueryError,
  collectionQueryFromParams,
  queryCollection,
} from "./collection-query.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { escapeHtml, type DashboardView } from "./server.js";

/**
 * Claim browser (#619): shared collection contract over saved claim
 * extractions. Accepted occurrences, legacy extractions, candidates and
 * rejections stay distinct; every row links to its own saved detail and exact
 * extraction version, and nothing is merged or re-extracted on view.
 */

const CATEGORY_CLASS = {
  accepted: "done",
  legacy: "pending",
  candidate: "pending",
  rejected: "failed",
} as const;

const badge = (category: keyof typeof CATEGORY_CLASS) =>
  `<span class="s-${CATEGORY_CLASS[category]}">${escapeHtml(category)}</span>`;

export function claimBrowseViews(
  content?: Pick<GitArtifactStore, "list" | "lookup">,
  claims?: ClaimsPort,
): DashboardView[] {
  const list: DashboardView = {
    path: "/claims/browse",
    title: "Claim browser",
    async render(url) {
      if (!content || !claims)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const adapter = claimCollection(content, claims);
      const raw = collectionQueryFromParams(url);
      const q = (raw.text ?? "").slice(0, 200);
      const f = (raw.filters ?? {}) as Record<string, string>;
      const option = (name: string, values: string[]) =>
        `<label>${name} <select name="f.${name}"><option value="">any</option>${values
          .map(
            (v) =>
              `<option value="${v}"${f[name] === v ? " selected" : ""}>${escapeHtml(v)}</option>`,
          )
          .join("")}</select></label>`;
      const form = `<form method="get" action="/claims/browse"><label>Text <input name="q" value="${escapeHtml(q)}" maxlength="200"></label> <label>Post <input name="f.post" value="${escapeHtml(f.post ?? "")}" maxlength="400" placeholder="publication/post"></label> ${option("category", ["accepted", "legacy", "candidate", "rejected"])} ${option("kind", ["assertion", "quotation", "question", "speculation"])} <label>Theme <input name="f.theme" value="${escapeHtml(f.theme ?? "")}" maxlength="40" placeholder="theme-hex"></label> <button>Search</button></form>`;
      let page;
      try {
        page = await queryCollection(adapter, raw);
      } catch (error) {
        if (error instanceof CollectionQueryError)
          return `${form}<p class="empty">That filter is not valid for claims.</p>`;
        return `${form}<p class="empty">Saved claims are unavailable right now.</p>`;
      }
      const notes = page.limitations.map((l) => `<p class="empty">${escapeHtml(l)}</p>`).join("");
      const rows = (page.rows as ClaimBrowseRow[])
        .map((r) => {
          const c = r.row;
          const detail = `/claims/view?${new URLSearchParams({ result: c.result, category: c.category, index: String(c.index) }).toString()}`;
          const limitations = r.limitations?.length
            ? `<br><span class="empty">${escapeHtml(r.limitations.join("; "))}</span>`
            : "";
          return `<tr><td><a href="${escapeHtml(detail)}">${escapeHtml(c.statement ?? `${c.category} entry ${c.index}`)}</a>${c.passage ? `<br><blockquote>${escapeHtml(c.passage.slice(0, 300))}</blockquote>` : ""}${limitations}</td><td>${badge(c.category)}${c.kind ? ` <span class="empty">${escapeHtml(c.kind)}</span>` : ""}</td><td>${escapeHtml(c.publicationId)}/${escapeHtml(c.postId)}${c.claimRecordId ? `<br><code>${escapeHtml(c.claimRecordId)}</code>` : ""}</td><td><code>${escapeHtml(r.artifact.commit.slice(0, 12))}</code><br><span class="empty">${escapeHtml(r.artifact.hash.slice(0, 19))}…</span></td></tr>`;
        })
        .join("");
      const params = new URLSearchParams(url.searchParams);
      params.delete("after");
      const next = page.next
        ? `<p><a href="/claims/browse?${escapeHtml(new URLSearchParams([...params, ["after", page.next]]).toString())}">Continue</a></p>`
        : "";
      if (page.rows.length === 0) {
        const filtered = q || Object.values(f).some(Boolean);
        return `${form}${notes}<p class="empty">${filtered ? "No saved claims match this search." : "No claim extractions have been saved yet."}</p>`;
      }
      return `${form}${notes}<p>Extraction output only: accepted occurrences, legacy extractions, refinement candidates and rejected diagnostics stay distinct, and none of this is a truth or research verdict. Rows are in stored order; opening one shows its exact saved extraction.</p>
<div class="wrap"><table><thead><tr><th>Claim</th><th>Category</th><th>Source</th><th>Extraction version</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };
  return [list];
}
