import { renderPostTrace, type PostTrace } from "../diagnostics/post-trace.js";
import {
  traceArticle,
  type ArticleTrace,
  type RecentArticlesPort,
  type RunStatusPort,
} from "./articles.js";
import { escapeHtml, type DashboardView } from "./server.js";

/** Article list and per-revision trace pages (#377). */

export const RECENT_LIMIT = 25;
const ID = /^[a-z0-9][a-z0-9-]{0,299}$/;

export interface ArticleViewDeps {
  articles?: RecentArticlesPort;
  runs?: RunStatusPort;
  trace?: (post: { publicationId: string; postId: string }) => Promise<PostTrace>;
}

const link = (p: { publicationId: string; postId: string }) =>
  `/articles/trace?publication=${encodeURIComponent(p.publicationId)}&post=${encodeURIComponent(p.postId)}`;
const badge = (state: string, text = state) =>
  `<span class="s-${escapeHtml(state)}">${escapeHtml(text)}</span>`;
const date = (iso?: string) => (iso ? escapeHtml(iso.slice(0, 10)) : "undated");

export function articleViews(deps: ArticleViewDeps): DashboardView[] {
  const list: DashboardView = {
    path: "/articles",
    title: "Articles",
    async render() {
      if (!deps.articles) {
        return '<p class="empty">The article index is not configured for the dashboard.</p>';
      }
      const recent = await deps.articles.recent(RECENT_LIMIT);
      if (recent.length === 0) return '<p class="empty">No archived articles are indexed yet.</p>';
      const rowsHtml = await Promise.all(
        recent.map(async (a) => {
          let summary = "unknown";
          if (deps.runs) {
            try {
              const s = await deps.runs.status(a);
              summary =
                s.state === "finished"
                  ? s.result.outcome === "failed"
                    ? "failed"
                    : "completed"
                  : s.state === "running"
                    ? "pending"
                    : s.state;
            } catch {
              summary = "unknown";
            }
          }
          return `<tr><td>${date(a.publishedAt)}</td><td><a href="${escapeHtml(link(a))}">${escapeHtml(a.title ?? a.postId)}</a></td><td>${escapeHtml(a.publicationId)}</td><td>${badge(summary)}</td></tr>`;
        }),
      );
      return `<p>The ${recent.length} most recent archived articles, newest first. Run status is for the archived revision.</p>
<div class="wrap"><table><thead><tr><th>Published</th><th>Article</th><th>Publication</th><th>Run</th></tr></thead>
<tbody>${rowsHtml.join("")}</tbody></table></div>`;
    },
  };

  const detail: DashboardView = {
    path: "/articles/trace",
    title: "Article trace",
    hidden: true,
    async render(url) {
      const publicationId = url.searchParams.get("publication") ?? "";
      const postId = url.searchParams.get("post") ?? "";
      if (!ID.test(publicationId) || !ID.test(postId)) {
        return '<p class="empty">Choose an article from the list.</p>';
      }
      const post = { publicationId, postId };
      const t = await traceArticle({
        post,
        ...(deps.articles ? { articles: deps.articles } : {}),
        ...(deps.runs ? { runs: deps.runs } : {}),
        ...(deps.trace ? { trace: () => deps.trace!(post) } : {}),
      });
      return renderTrace(t);
    },
  };
  return [list, detail];
}

export function renderTrace(t: ArticleTrace): string {
  const facts = [
    ["Publication", escapeHtml(t.post.publicationId)],
    ["Post", escapeHtml(t.post.postId)],
    ["Correlation ID", `<code>${escapeHtml(t.correlationId)}</code>`],
    ["Revision", t.sourceVersion ? `<code>${escapeHtml(t.sourceVersion)}</code>` : "unknown"],
    ["Run", badge(t.summary)],
    ...(t.outcome ? [["Outcome", escapeHtml(t.outcome)]] : []),
    ...(t.reason ? [["Reason", escapeHtml(t.reason)]] : []),
  ];
  const stages = t.stages
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.stage)}</td><td>${badge(s.state)}</td><td>${s.detail ? escapeHtml(s.detail) : ""}</td></tr>`,
    )
    .join("");
  const research = t.research.length
    ? `<h2>Research</h2><div class="wrap"><table><thead><tr><th>Job</th><th>Outcome</th></tr></thead><tbody>${t.research
        .map(
          (r) =>
            `<tr><td><code>${escapeHtml(r.jobId)}</code></td><td>${escapeHtml(r.outcome)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : "";
  // The existing post trace output is allowlisted text; it is shown escaped.
  const diagnostics = t.trace
    ? `<h2>Capture and analysis</h2><pre>${escapeHtml(renderPostTrace(t.trace))}</pre>`
    : "";
  return `<p><a href="/articles">All articles</a></p>
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<h2>Stages</h2>
<div class="wrap"><table><thead><tr><th>Stage</th><th>State</th><th>Detail</th></tr></thead><tbody>${stages}</tbody></table></div>
${research}${diagnostics}`;
}
