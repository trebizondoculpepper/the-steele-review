import { renderPostTrace, type PostTrace } from "../diagnostics/post-trace.js";
import {
  traceArticle,
  type ArticleContentPort,
  type ArticleTrace,
  type CapturedSource,
  type EditorialOutcome,
  type SourcePort,
  type ReceiptsPort,
  type RecentArticlesPort,
  type RunStatusPort,
  type ArchivedArticle,
} from "./articles.js";
import { escapeHtml, type DashboardView } from "./server.js";
import type { ThemesPort } from "./themes.js";
import type { ArticleClaims, ArticleClaimLink, ClaimsPort } from "./claims.js";

/** Article list and per-revision trace pages (#377). */

export const RECENT_LIMIT = 25;
const ID = /^[a-z0-9][a-z0-9-]{0,299}$/;

export interface ArticleViewDeps {
  /** Saved theme proposals for the trace page (#496). */
  themes?: ThemesPort;
  /** Saved claims for the trace page (#497). */
  claims?: ClaimsPort;
  articles?: RecentArticlesPort;
  runs?: RunStatusPort;
  trace?: (post: { publicationId: string; postId: string }) => Promise<PostTrace>;
  content?: ArticleContentPort;
  receipts?: ReceiptsPort;
  /** Retained captured source for the detail page (#446). */
  source?: SourcePort;
  canTrigger?: boolean;
  /** Recovery of a stopped run is configured (#480). */
  canRecover?: boolean;
  /** Validated canonical origin from entry-point configuration, never request headers. */
  actionOrigin?: string;
}

const link = (p: { publicationId: string; postId: string }) =>
  `/articles/trace?publication=${encodeURIComponent(p.publicationId)}&post=${encodeURIComponent(p.postId)}`;
const badge = (state: string, text = state) =>
  `<span class="s-${escapeHtml(state)}">${escapeHtml(text)}</span>`;
const date = (iso?: string) => (iso ? escapeHtml(iso.slice(0, 10)) : "undated");

/** Run-status filter for the Articles list (#510). Editorial outcome, not just workflow state. */
/** Bounded scan when filtering by run status: run state is not an index field. */
export const STATUS_FILTER_PAGES = 5;

export const ARTICLE_STATUS_FILTERS = [
  "all",
  "not-started",
  "pending",
  "failed",
  "evidence-gap",
  "unverified",
  "approved",
] as const;
export type ArticleStatusFilter = (typeof ARTICLE_STATUS_FILTERS)[number];

/** Which filter bucket a rendered summary belongs to. */
export function statusBucket(summary: string): Exclude<ArticleStatusFilter, "all"> {
  switch (summary) {
    case "not-started":
      return "not-started";
    case "pending":
    case "running":
      return "pending";
    case "failed":
    case "credit-exhausted":
      return "failed";
    case "evidence-gap":
      return "evidence-gap";
    case "rejected":
    case "unverified":
      return "unverified";
    case "verified":
      return "approved";
    default:
      return "unverified";
  }
}

export function articleViews(deps: ArticleViewDeps): DashboardView[] {
  const recoveryLink = (publicationId: string, postId: string, revision: string) =>
    escapeHtml(
      `${deps.actionOrigin ?? ""}/articles/recover?publication=${encodeURIComponent(publicationId)}&post=${encodeURIComponent(postId)}&revision=${encodeURIComponent(revision)}`,
    );
  const runLink = (publicationId: string, postId: string, revision: string) =>
    escapeHtml(
      `${deps.actionOrigin ?? ""}/articles/run?publication=${encodeURIComponent(publicationId)}&post=${encodeURIComponent(postId)}&revision=${encodeURIComponent(revision)}`,
    );
  const list: DashboardView = {
    path: "/articles",
    title: "Articles",
    async render(url: URL) {
      if (!deps.articles) {
        return '<p class="empty">The article index is not configured for the dashboard.</p>';
      }
      const sort = url.searchParams.get("sort") === "oldest" ? "oldest" : "newest";
      const after = url.searchParams.get("after") ?? undefined;
      const requested = url.searchParams.get("status") ?? "all";
      const filter: ArticleStatusFilter = (ARTICLE_STATUS_FILTERS as readonly string[]).includes(
        requested,
      )
        ? (requested as ArticleStatusFilter)
        : "all";

      /** Editorial summary for one archived revision (#486, #510). */
      const summaryFor = async (a: ArchivedArticle): Promise<string> => {
        if (!deps.runs) return "unknown";
        try {
          const s = await deps.runs.status(a);
          if (s.state === "finished" && isCreditBlocked(s.result.reason)) return "credit-exhausted";
          if (s.state === "finished") {
            return s.result.outcome === "failed"
              ? "failed"
              : s.result.outcome === "rejected"
                ? "rejected"
                : s.result.outcome === "evidence-gap"
                  ? "evidence-gap"
                  : s.result.outcome === "drafted-unverified"
                    ? "unverified"
                    : "verified";
          }
          return s.state === "running" ? "pending" : s.state;
        } catch {
          return "unknown";
        }
      };

      // A status filter has to look past the current page, because the run
      // state is not part of the index query. The scan is bounded so a filter
      // that matches nothing cannot walk the whole archive.
      const rows: Array<{ article: ArchivedArticle; summary: string }> = [];
      let cursor = after;
      let next: string | undefined;
      const pages = filter === "all" ? 1 : STATUS_FILTER_PAGES;
      for (let i = 0; i < pages; i++) {
        const p = deps.articles.page
          ? await deps.articles.page({
              sort,
              limit: RECENT_LIMIT,
              ...(cursor ? { after: cursor } : {}),
            })
          : { entries: await deps.articles.recent(RECENT_LIMIT) };
        const withSummary = await Promise.all(
          p.entries.map(async (article) => ({ article, summary: await summaryFor(article) })),
        );
        rows.push(
          ...(filter === "all"
            ? withSummary
            : withSummary.filter((r) => statusBucket(r.summary) === filter)),
        );
        next = p.next;
        if (!p.next || rows.length >= RECENT_LIMIT) break;
        cursor = p.next;
      }
      const visible = rows.slice(0, RECENT_LIMIT);
      const query = (over: Record<string, string | undefined>) => {
        const params = new URLSearchParams();
        const merged = { sort, status: filter === "all" ? undefined : filter, ...over };
        for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
        const qs = params.toString();
        return `/articles${qs ? `?${qs}` : ""}`;
      };
      const filterLinks = `<p class="filtering">Status: ${(
        ARTICLE_STATUS_FILTERS as readonly ArticleStatusFilter[]
      )
        .map((f) =>
          f === filter
            ? `<strong>${f}</strong>`
            : `<a href="${escapeHtml(query({ status: f === "all" ? undefined : f, after: undefined }))}">${f}</a>`,
        )
        .join(" · ")}</p>`;
      const pagingControls = `${filterLinks}${
        deps.articles.page
          ? `<p class="sorting">Sort: ${
              sort === "newest"
                ? `<strong>newest first</strong> · <a href="${escapeHtml(query({ sort: "oldest", after: undefined }))}">oldest first</a>`
                : `<a href="${escapeHtml(query({ sort: "newest", after: undefined }))}">newest first</a> · <strong>oldest first</strong>`
            }</p>${
              next
                ? `<p class="paging"><a href="${escapeHtml(query({ after: next }))}">Next page</a></p>`
                : ""
            }`
          : ""
      }`;
      if (visible.length === 0)
        return `${pagingControls}<p class="empty">${
          filter === "all"
            ? "No archived articles are indexed yet."
            : `No archived articles currently have the status “${escapeHtml(filter)}”.`
        }</p>`;
      const rowsHtml = await Promise.all(
        visible.map(async ({ article: a, summary }) => {
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
      return `<p>Showing ${visible.length} archived article${visible.length === 1 ? "" : "s"}${
        filter === "all" ? "" : ` with status “${escapeHtml(filter)}”`
      }, ${sort === "newest" ? "newest" : "oldest"} first. Run status is for the archived revision.</p>
<div class="wrap"><table><thead><tr><th>Published</th><th>Article</th><th>Publication</th><th>Run</th>${deps.canTrigger ? "<th>Action</th>" : ""}</tr></thead>
<tbody>${rowsHtml.join("")}</tbody></table></div>${pagingControls}`;
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
        ...(deps.source ? { source: deps.source } : {}),
        ...(deps.themes ? { themes: deps.themes } : {}),
        ...(deps.claims ? { claims: deps.claims } : {}),
      });
      const trigger =
        deps.canTrigger && t.sourceVersion
          ? `<p><a href="${runLink(publicationId, postId, t.sourceVersion)}">Run this revision</a></p>`
          : "";
      // A run stopped on provider credit can be recovered explicitly (#480).
      const recovery =
        deps.canRecover && t.sourceVersion && isCreditBlocked(t.reason)
          ? `<p><a href="${recoveryLink(publicationId, postId, t.sourceVersion)}">Recover stopped run</a></p>`
          : "";
      return trigger + recovery + renderTrace(t);
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

/** Human wording for the editorial outcome (#486). Never implies delivery. */
export function editorialText(
  editorial: EditorialOutcome,
  outCome?: string,
  approvalRecorded = false,
): string {
  switch (editorial) {
    case "verified":
      return approvalRecorded
        ? "verified — approval recorded for dispatch"
        : "verified — no dispatch approval recorded";
    case "rejected":
      return "verification rejected — this draft was not approved";
    case "evidence-gap":
      return "evidence gap — drafting was not reached";
    case "unverified":
      return "unverified — verification was not reached";
    default:
      return outCome === "failed" ? "not evaluated — the workflow failed" : "not evaluated";
  }
}

/** Grouped claim occurrences for one article revision (#497). */
function renderClaims(claims: ArticleClaims | undefined): string {
  if (!claims) return "";
  const link = (c: ArticleClaimLink) =>
    `/claims/view?result=${encodeURIComponent(c.result)}&category=${c.category}&index=${c.index}`;
  const list = (rows: ArticleClaimLink[], describe: (c: ArticleClaimLink) => string) =>
    rows.length === 0
      ? ""
      : `<ul>${rows
          .map(
            (c) =>
              `<li><a href="${escapeHtml(link(c))}">${escapeHtml(describe(c))}</a>${c.kind ? ` <span class="empty">(${escapeHtml(c.kind)})</span>` : ""}</li>`,
          )
          .join("")}</ul>`;
  const sections = [
    ["Accepted (theme-linked)", list(claims.accepted, (c) => c.statement ?? "claim")],
    [
      "Legacy extractions",
      list(claims.legacy, (c) => c.statement ?? "claim") +
        (claims.legacy.length
          ? '<p class="empty">Saved under an earlier extraction schema; shown as recorded, not re-certified.</p>'
          : ""),
    ],
    [
      "Refinement candidates",
      list(claims.candidates, (c) =>
        `${c.statement ?? "candidate"}${c.reasons?.length ? ` — ${c.reasons.join(", ")}` : ""}`,
      ),
    ],
    [
      "Rejected passages (diagnostics)",
      list(claims.rejected, (c) => c.rejectionReason ?? "rejected"),
    ],
  ]
    .filter(([, body]) => body !== "")
    .map(([title, body]) => `<h3>${title}</h3>${body}`)
    .join("");
  const state =
    claims.state === "not-analysed"
      ? '<p class="empty">No claims are saved for this exact revision.</p>'
      : claims.state === "unavailable"
        ? '<p class="empty">Saved claims are unavailable.</p>'
        : claims.state === "partial"
          ? '<p class="empty">The claim scan was incomplete; some saved results could not be read.</p>'
          : "";
  return `<h2>Claims</h2><p class="empty">Extraction output only: these are not truth or research verdicts.</p>${sections}${state}`;
}

export function renderTrace(t: ArticleTrace): string {
  const facts = [
    ["Publication", escapeHtml(t.post.publicationId)],
    ["Post", escapeHtml(t.post.postId)],
    ["Correlation ID", `<code>${escapeHtml(t.correlationId)}</code>`],
    ["Revision", t.sourceVersion ? `<code>${escapeHtml(t.sourceVersion)}</code>` : "unknown"],
    ["Workflow", badge(t.summary)],
    [
      "Editorial outcome",
      escapeHtml(editorialText(t.editorial, t.outcome, t.approvalRecorded === true)),
    ],
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
  const recoveryDraft = t.recovery?.draft
    ? `<h3>Recovery draft</h3><p>Saved revision <code>sha256:${escapeHtml(t.recovery.draft.hash)}</code>.</p><pre>${escapeHtml(t.recovery.draft.text)}</pre>`
    : "";
  const recoveryVerification = t.recovery?.verification
    ? `<h3>Recovery verification</h3><p>${badge(t.recovery.verification.outcome === "approved" ? "done" : "failed", t.recovery.verification.outcome)}${t.recovery.verification.matchesDraft ? " · binds to the recovery draft" : " · does not bind to the recovery draft"}</p>`
    : "";
  const recoveryReceipts = t.recovery?.receipts?.length
    ? `<h3>Recovery delivery receipts</h3><div class="wrap"><table><thead><tr><th>Destination</th><th>Action</th><th>State</th><th>Delivered</th><th>Link</th></tr></thead><tbody>${t.recovery.receipts
        .map((r) => {
          const confirmed =
            !r.simulated && typeof r.url === "string" && r.url.startsWith("https://");
          const link = confirmed
            ? `<a href="${escapeHtml(r.url!)}" rel="noopener noreferrer">${escapeHtml(r.url!)}</a>`
            : "";
          return `<tr><td>${escapeHtml(r.destination)}</td><td>${escapeHtml(r.action)}</td><td>${badge(r.simulated ? "pending" : "done", r.simulated ? "simulated" : "delivered")}</td><td>${escapeHtml(r.deliveredAt)}</td><td>${link}</td></tr>`;
        })
        .join("")}</tbody></table></div>${t.recovery.receiptsTruncated ? '<p class="empty">The receipt scan reached its bound; some receipts may not be shown.</p>' : ""}`
    : "";
  const themes = t.themes
    ? (() => {
        const label =
          t.themes.state === "unavailable"
            ? "saved themes are unavailable"
            : t.themes.state === "not-analysed"
              ? "no theme proposals are saved for this exact revision"
              : t.themes.state === "partial"
                ? "the theme scan was incomplete"
                : "";
        const list =
          t.themes.themes.length === 0
            ? ""
            : `<ul>${t.themes.themes
                .map((theme: { result: string; id: string; title: string; description?: string }) => {
                  const link = `/themes/view?result=${encodeURIComponent(theme.result)}&id=${encodeURIComponent(theme.id)}`;
                  return `<li><a href="${escapeHtml(link)}">${escapeHtml(theme.title)}</a>${
                    theme.description ? ` — ${escapeHtml(theme.description)}` : ""
                  } <span class="empty">(extractor proposal, not canonical)</span></li>`;
                })
                .join("")}</ul>`;
        return `<h2>Themes</h2>${list}${label ? `<p class="empty">${escapeHtml(label)}</p>` : ""}`;
      })()
    : "";
  const claims = renderClaims(t.claims);
  const recovery = t.recovery
    ? `<h2>Recovery</h2><p>${badge(t.recovery.summary)}${t.recovery.outcome ? ` ${escapeHtml(t.recovery.outcome)}` : ""}${t.recovery.reason ? ` · ${escapeHtml(t.recovery.reason)}` : ""}</p>${
        t.recovery.workflowKey
          ? `<p>Recovery run <code>${escapeHtml(t.recovery.workflowKey)}</code></p>`
          : ""
      }${
        t.recovery.progress
          ? `<p>${escapeHtml(t.recovery.progress.stage)} ${t.recovery.progress.status} at ${escapeHtml(t.recovery.progress.at.slice(0, 19).replace("T", " "))} UTC</p>`
          : ""
      }${recoveryDraft}${recoveryVerification}${recoveryReceipts}`
    : "";
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
  return `${isCreditBlocked(t.reason) ? creditWarning(1) : ""}<p><a href="/articles">All articles</a> · <a href="/drafts?${escapeHtml(new URLSearchParams({ publication: t.post.publicationId, post: t.post.postId }).toString())}">All saved drafts for this post</a></p>
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<h2>Stages</h2>
<div class="wrap"><table><thead><tr><th>Stage</th><th>State</th><th>Detail</th></tr></thead><tbody>${stages}</tbody></table></div>
${source}${themes}${claims}${recovery}${research}${draft}${verification}${receipts}${diagnostics}`;
}
