import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { AssessmentsPort } from "./assessments.js";
import {
  CollectionQueryError,
  collectionQueryFromParams,
  queryCollection,
} from "./collection-query.js";
import type { JudgmentsPort } from "./judgments.js";
import { REVIEW_PATH } from "./review-views.js";
import { reviewsCollection, type ReviewBrowseRow } from "./reviews-collection.js";
import type { ReviewHistoryPort } from "./reviews.js";
import { escapeHtml, type DashboardView } from "./server.js";

/**
 * Review search (#622): assessments, judgments and legacy verifier reports as
 * separate lists, with recorded outcomes only. Read-only.
 */
export function reviewsBrowseViews(
  ports?: { assessments: AssessmentsPort; judgments: JudgmentsPort; reviews: ReviewHistoryPort },
  content?: Pick<GitArtifactStore, "lookup">,
): DashboardView[] {
  const view: DashboardView = {
    path: "/reviews/search",
    title: "Review search",
    async render(url) {
      if (!ports || !content)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const raw = collectionQueryFromParams(url);
      const f = (raw.filters ?? {}) as Record<string, string>;
      const kind = f.kind === "judgment" || f.kind === "verifier-report" ? f.kind : "assessment";
      const q = (raw.text ?? "").slice(0, 200);
      const opt = (value: string, label: string) =>
        `<option value="${value}"${kind === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const form = `<form method="get" action="/reviews/search"><label>Text <input name="q" value="${escapeHtml(q)}" maxlength="200"></label> <label>Records <select name="f.kind">${opt("assessment", "assessments")}${opt("judgment", "judgments")}${opt("verifier-report", "legacy verifier reports")}</select></label> <label>Post <input name="f.post" value="${escapeHtml(f.post ?? "")}" maxlength="600" placeholder="publication/post"></label> <label>Outcome <input name="f.outcome" value="${escapeHtml(f.outcome ?? "")}" maxlength="40"></label> <button>Search</button></form>`;
      let page;
      try {
        page = await queryCollection(reviewsCollection(ports, content), raw);
      } catch (error) {
        if (error instanceof CollectionQueryError)
          return `${form}<p class="empty">That filter is not valid for these records.</p>`;
        return `${form}<p class="empty">Saved review records are unavailable right now.</p>`;
      }
      const notes = page.limitations.map((l) => `<p class="empty">${escapeHtml(l)}</p>`).join("");
      const detail = (r: ReviewBrowseRow) =>
        r.kind === "assessment"
          ? `/assessments/view?${new URLSearchParams({ path: r.id }).toString()}`
          : r.kind === "judgment"
            ? `/judgments/view?${new URLSearchParams({ path: r.id }).toString()}`
            : `${REVIEW_PATH}?${new URLSearchParams({ publication: r.publicationId, post: r.postId }).toString()}`;
      const rows = (page.rows as ReviewBrowseRow[])
        .map(
          (r) =>
            `<tr><td><a href="${escapeHtml(detail(r))}">${escapeHtml(`${r.publicationId}/${r.postId}`)}</a></td><td>${escapeHtml(r.outcome)}</td><td>${r.count === undefined ? '<span class="empty">not recorded</span>' : escapeHtml(String(r.count))}</td><td>${escapeHtml(r.at ?? "")}</td><td><code>${escapeHtml(`${r.artifact.commit.slice(0, 12)}:${r.artifact.path}`)}</code></td></tr>`,
        )
        .join("");
      const params = new URLSearchParams(url.searchParams);
      params.delete("after");
      const next = page.next
        ? `<p><a href="/reviews/search?${escapeHtml(new URLSearchParams([...params, ["after", page.next]]).toString())}">Continue</a></p>`
        : "";
      if (page.rows.length === 0)
        return `${form}${notes}<p class="empty">No matching records on this page.</p>${next}`;
      const countHead =
        kind === "assessment" ? "Findings" : kind === "judgment" ? "Gates" : "Issues";
      return `${form}${notes}<p>Only recorded outcomes are shown; a missing or incomplete record is never approval.</p><div class="wrap"><table><thead><tr><th>Post</th><th>Outcome</th><th>${countHead}</th><th>Recorded</th><th>Saved record</th></tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };
  return [view];
}
