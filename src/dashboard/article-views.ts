import { renderPostTrace, type PostTrace } from "../diagnostics/post-trace.js";
import {
  traceArticle,
  type ArticleContentPort,
  type ArticleTrace,
  type CapturedSource,
  type ReceiptsPort,
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
  content?: ArticleContentPort;
  receipts?: ReceiptsPort;
  canTrigger?: boolean;
  /** Validated canonical origin from entry-point configuration, never request headers. */
  actionOrigin?: string;
}

const link = (p: { publicationId: string; postId: string }) =>
  `/articles/trace?publication=${encodeURIComponent(p.publicationId)}&post=${encodeURIComponent(p.postId)}`;
const badge = (state: string, text = state) =>
  `<span class="s-${escapeHtml(state)}">${escapeHtml(text)}</span>`;
const date = (iso?: string) => (iso ? escapeHtml(iso.slice(0, 10)) : "undated");

export function articleViews(deps: ArticleViewDeps): DashboardView[] {
  const runLink = (publicationId: string, postId: string, revision: string) =>
    escapeHtml(
      `${deps.actionOrigin ?? ""}/articles/run?publication=${encodeURIComponent(publicationId)}&post=${encodeURIComponent(postId)}&revision=${encodeURIComponent(revision)}`,
    );
  const list: DashboardView = {
    path: "/articles",
    title: "Articles",
    async render() {
      if (!deps.articles) {
        return '<p class="empty">The article index is not configured for the dashboard.</p>';
      }
      const recent = await deps.articles.recent(RECENT_LIMIT);
      if (recent.length === 0) return '<p class="empty">No archived articles are indexed yet.</p>';
      let creditBlocked = 0;
      const rowsHtml = await Promise.all(
        recent.map(async (a) => {
          let summary = "unknown";
          if (deps.runs) {
            try {
              const s = await deps.runs.status(a);
              if (s.state === "finished" && isCreditBlocked(s.result.reason)) {
                creditBlocked++;
                summary = "credit-exhausted";
              } else
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
          const action = deps.canTrigger
            ? `<td>${
                /^sha256:[0-9a-f]{64}$/.test(a.sourceVersion)
                  ? `<a href="${runLink(a.publicationId, a.postId, a.sourceVersion)}">Run this revision</a>`
                  : "Revision unavailable"
              }</td>`
            : "";
          return `<tr><td>${date(a.publishedAt)}</td><td><a href="${escapeHtml(link(a))}">${escapeHtml(a.title ?? a.postId)}</a></td><td>${escapeHtml(a.publicationId)}</td><td>${badge(summary)}</td>${action}</tr>`;
        }),
      );
      return `${creditBlocked ? creditWarning(creditBlocked) : ""}<p>The ${recent.length} most recent archived articles, newest first. Run status is for the archived revision.</p>
<div class="wrap"><table><thead><tr><th>Published</th><th>Article</th><th>Publication</th><th>Run</th>${deps.canTrigger ? "<th>Action</th>" : ""}</tr></thead>
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
        ...(deps.content ? { content: deps.content } : {}),
        ...(deps.receipts ? { receipts: deps.receipts } : {}),
      });
      const trigger =
        deps.canTrigger && t.sourceVersion
          ? `<p><a href="${runLink(publicationId, postId, t.sourceVersion)}">Run this revision</a></p>`
          : "";
      return trigger + renderTrace(t);
    },
  };
  return [list, detail];
}

/** A run stopped because the model provider's credit budget ran out (#407). */
export const isCreditBlocked = (reason?: string) =>
  typeof reason === "string" && /(^|: )credit-exhausted$/.test(reason.trim());

/** Actionable, secret-free warning: what happened and how to recover. */
export function creditWarning(runs: number): string {
  return `<p class="warning" role="alert"><strong>Provider credit exhausted.</strong> ${runs} recent run${runs === 1 ? "" : "s"} stopped because the model provider's credit budget ran out. This is not a finding about any article. Add credit or raise the key's limit with the provider, then recover the affected revisions as described in the article pipeline operations guide (provider credit exhaustion); completed stage results are reused.</p>`;
}

function renderSource(source: CapturedSource | undefined): string {
  if (!source) return "";
  if (source.state !== "recorded") {
    return `<h2>Retained source</h2><p class="empty">Captured source: ${escapeHtml(source.state)}.</p>`;
  }
  const link =
    source.url === undefined
      ? ""
      : ` <a href="${escapeHtml(source.url)}" rel="noopener noreferrer">source</a>`;
  const mismatch =
    source.matchesRevision === false
      ? '<p class="s-failed">This capture does not match the revision selected for the run; the recorded text is shown as archived.</p>'
      : "";
  return `<h2>Retained source</h2>
<p>${source.title ? escapeHtml(source.title) : "untitled"}${link} · ${escapeHtml(source.method)} · ${source.complete ? "complete" : "INCOMPLETE"} · <code>${escapeHtml(source.revision)}</code></p>
${mismatch}
<p>Shown as text; markup is never executed.${source.truncated ? " Display truncated." : ""}</p>
<pre>${escapeHtml(source.text)}</pre>`;
}

export function renderTrace(t: ArticleTrace): string {
  const facts = [
    ["Publication", escapeHtml(t.post.publicationId)],
    ["Post", escapeHtml(t.post.postId)],
    ["Correlation ID", `<code>${escapeHtml(t.correlationId)}</code>`],
    ["Revision", t.sourceVersion ? `<code>${escapeHtml(t.sourceVersion)}</code>` : "unknown"],
    ["Run", badge(t.summary)],
    ...(t.summary === "pending"
      ? [
          [
            "Progress",
            `${t.lastUpdate ? `last update ${escapeHtml(t.lastUpdate.slice(0, 19).replace("T", " "))} UTC · ` : ""}<a href="${escapeHtml(`/articles/trace?publication=${encodeURIComponent(t.post.publicationId)}&post=${encodeURIComponent(t.post.postId)}`)}">refresh</a>`,
          ],
        ]
      : []),
    ...(t.outcome ? [["Outcome", escapeHtml(t.outcome)]] : []),
    ...(t.reason ? [["Reason", escapeHtml(t.reason)]] : []),
  ];
  const stages = t.stages
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.stage)}</td><td>${badge(s.state)}</td><td>${s.detail ? escapeHtml(s.detail) : ""}</td></tr>`,
    )
    .join("");
  const researchRows = t.research
    .map(
      (r) =>
        `<tr><td><code>${escapeHtml(r.jobId)}</code></td><td>${escapeHtml(r.outcome)}</td></tr>`,
    )
    .join("");
  const research = researchRows
    ? `<h2>Research</h2><div class="wrap"><table><thead><tr><th>Job</th><th>Outcome</th></tr></thead><tbody>${researchRows}</tbody></table></div>`
    : "";
  // The existing post trace output is allowlisted text; it is shown escaped.
  const diagnostics = t.trace
    ? `<h2>Capture and analysis</h2><pre>${escapeHtml(renderPostTrace(t.trace))}</pre>`
    : "";
  const source = renderSource(t.source);
  const draft = t.draft
    ? `<h2>Draft</h2><p>Saved revision <code>sha256:${escapeHtml(t.draft.hash)}</code>. Shown as text; its markup is never executed.</p><pre>${escapeHtml(t.draft.text)}</pre>`
    : "";
  const verification = t.verification
    ? `<h2>Verification</h2><p>${badge(t.verification.outcome === "approved" ? "done" : "failed", t.verification.outcome)} ${
        t.verification.matchesDraft
          ? "binds to the exact saved draft above."
          : "does not bind to the saved draft (a different revision was checked)."
      }</p>${t.verification.draftHash ? `<p>Report draft <code>${escapeHtml(t.verification.draftHash)}</code></p>` : ""}`
    : "";
  const receiptRows = t.receipts
    .map((r) => {
      const confirmed = !r.simulated && typeof r.url === "string" && r.url.startsWith("https://");
      const link = confirmed
        ? `<a href="${escapeHtml(r.url!)}" rel="noopener noreferrer">${escapeHtml(r.url!)}</a>`
        : "";
      return `<tr><td>${escapeHtml(r.destination)}</td><td>${escapeHtml(r.action)}</td><td>${badge(r.simulated ? "pending" : "done", r.simulated ? "simulated" : "delivered")}</td><td>${escapeHtml(r.deliveredAt)}</td><td>${link}</td></tr>`;
    })
    .join("");
  const receipts =
    receiptRows.length === 0 && !t.receiptsTruncated
      ? ""
      : `<h2>Delivery receipts</h2>${
          t.receiptsTruncated
            ? '<p class="empty">The receipt scan reached its bound; some receipts may not be shown.</p>'
            : ""
        }${
          receiptRows.length === 0
            ? ""
            : `<div class="wrap"><table><thead><tr><th>Destination</th><th>Action</th><th>State</th><th>Delivered</th><th>Link</th></tr></thead><tbody>${receiptRows}</tbody></table></div>`
        }`;
  return `${isCreditBlocked(t.reason) ? creditWarning(1) : ""}<p><a href="/articles">All articles</a></p>
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<h2>Stages</h2>
<div class="wrap"><table><thead><tr><th>Stage</th><th>State</th><th>Detail</th></tr></thead><tbody>${stages}</tbody></table></div>
${source}${research}${draft}${verification}${receipts}${diagnostics}`;
}
