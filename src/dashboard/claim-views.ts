import type { ClaimCategory, ClaimRow, ClaimsPort } from "./claims.js";
import { escapeHtml, type DashboardView } from "./server.js";

/** Read-only Claims pages (#494). */

const CATEGORY_LABEL: Record<ClaimCategory, string> = {
  accepted: "accepted (theme-linked)",
  candidate: "candidate (awaiting triage)",
  rejected: "rejected (diagnostic)",
};
const ID = /^[a-z0-9][a-z0-9-]{0,299}$/;
const traceLink = (r: ClaimRow) =>
  `/articles/trace?${new URLSearchParams({ publication: r.publicationId, post: r.postId })}`;
const detailLink = (r: ClaimRow) =>
  `/claims/view?${new URLSearchParams({ result: r.result, category: r.category, index: String(r.index) })}`;
const themeLink = (r: ClaimRow, id: string) =>
  r.themeResultPath
    ? `/themes/view?${new URLSearchParams({ result: r.themeResultPath, id })}`
    : undefined;
const themesHtml = (r: ClaimRow) =>
  r.themes.length === 0
    ? '<span class="empty">none recorded</span>'
    : r.themes
        .map((t) => {
          const label = escapeHtml(t.title ?? t.id);
          const href = themeLink(r, t.id);
          return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
        })
        .join(", ");

export function claimViews(claims?: ClaimsPort): DashboardView[] {
  const list: DashboardView = {
    path: "/claims",
    title: "Claims",
    async render(url) {
      if (!claims)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const q = (url.searchParams.get("q") ?? "").slice(0, 200);
      const post = url.searchParams.get("post") ?? "";
      const theme = url.searchParams.get("theme") ?? "";
      const categoryRaw = url.searchParams.get("category") ?? "";
      const category = (["accepted", "candidate", "rejected"] as const).find(
        (c) => c === categoryRaw,
      );
      const after = url.searchParams.get("after") ?? undefined;
      const filter = {
        ...(q ? { query: q } : {}),
        ...(ID.test(post) ? { post } : {}),
        ...(/^theme-[0-9a-f]{24}$/.test(theme) ? { theme } : {}),
        ...(category ? { category } : {}),
      };
      const listing = await claims.list({ ...filter, ...(after ? { after } : {}) });
      const option = (v: string, label: string) =>
        `<option value="${v}"${categoryRaw === v ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const form = `<form method="get" action="/claims"><label>Text <input name="q" value="${escapeHtml(q)}" maxlength="200"></label> <label>Post <input name="post" value="${escapeHtml(post)}" maxlength="300"></label> <label>Category <select name="category">${option("", "all")}${option("accepted", CATEGORY_LABEL.accepted)}${option("candidate", CATEGORY_LABEL.candidate)}${option("rejected", CATEGORY_LABEL.rejected)}</select></label>${theme ? `<input type="hidden" name="theme" value="${escapeHtml(theme)}">` : ""} <button>Filter</button></form>`;
      if (listing.state === "unavailable")
        return `${form}<p class="empty">Saved claims are unavailable right now.</p>`;
      const notes = [
        listing.partial
          ? "This page reached its scan bound before finding a full page of matches; continue to scan further."
          : "",
        listing.unreadable ? `${listing.unreadable} saved extraction(s) could not be read.` : "",
      ]
        .filter(Boolean)
        .map((n) => `<p class="empty">${escapeHtml(n)}</p>`)
        .join("");
      const query = new URLSearchParams({
        ...(q ? { q } : {}),
        ...(filter.post ? { post } : {}),
        ...(filter.theme ? { theme } : {}),
        ...(category ? { category } : {}),
        ...(listing.next ? { after: listing.next } : {}),
      });
      const more = listing.next
        ? `<p><a href="/claims?${escapeHtml(query.toString())}">Continue</a>, saved extractions in storage order.</p>`
        : "<p>End of the saved extractions.</p>";
      if (listing.rows.length === 0) {
        return `${form}${notes}<p class="empty">${Object.keys(filter).length ? "No saved claims match in this range." : "No saved claims yet."}</p>${more}`;
      }
      const rows = listing.rows
        .map(
          (r) =>
            `<tr><td><a href="${escapeHtml(detailLink(r))}">${r.statement ? escapeHtml(r.statement) : '<span class="empty">no statement saved</span>'}</a></td><td>${escapeHtml(CATEGORY_LABEL[r.category])}</td><td>${themesHtml(r)}</td><td><a href="${escapeHtml(traceLink(r))}">${escapeHtml(r.postId)}</a></td></tr>`,
        )
        .join("");
      return `${form}${notes}<p>Claim proposals as extracted. A category is extraction status, never a verdict on whether a claim is true.</p>
<div class="wrap"><table><thead><tr><th>Claim</th><th>Category</th><th>Themes</th><th>Post</th></tr></thead><tbody>${rows}</tbody></table></div>${more}`;
    },
  };

  const detail: DashboardView = {
    path: "/claims/view",
    title: "Claim",
    hidden: true,
    async render(url) {
      if (!claims)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const category = (["accepted", "candidate", "rejected"] as const).find(
        (c) => c === url.searchParams.get("category"),
      );
      const index = Number.parseInt(url.searchParams.get("index") ?? "", 10);
      if (!category || !Number.isInteger(index) || index < 0)
        return '<p class="empty">Choose a claim from the list.</p>';
      const r = await claims.detail(url.searchParams.get("result") ?? "", category, index);
      if (!r) return '<p class="empty">Choose a claim from the list.</p>';
      const facts: [string, string][] = [
        ["Category", escapeHtml(CATEGORY_LABEL[r.category])],
        [
          "Statement",
          r.statement ? escapeHtml(r.statement) : '<span class="empty">no statement saved</span>',
        ],
        [
          "Quotation",
          r.passage
            ? `<blockquote>${escapeHtml(r.passage)}</blockquote>${r.span ? `<span class="empty">characters ${r.span.start}–${r.span.end} of the source</span>` : ""}${r.quoteRecovered ? ' <span class="empty">(recovered by a formatting rule, not verbatim)</span>' : ""}`
            : '<span class="empty">no quotation saved</span>',
        ],
        ...(r.speaker
          ? ([
              [
                "Speaker",
                escapeHtml(`${r.speaker.kind}${r.speaker.name ? `: ${r.speaker.name}` : ""}`),
              ],
            ] as [string, string][])
          : []),
        ...(r.sourcePublishedAt
          ? ([["Source published", escapeHtml(r.sourcePublishedAt)]] as [string, string][])
          : []),
        ...(r.kind ? ([["Assertion kind", escapeHtml(r.kind)]] as [string, string][]) : []),
        ...(r.reasons
          ? ([["Candidate reasons", escapeHtml(r.reasons.join(", "))]] as [string, string][])
          : []),
        ...(r.rejectionReason
          ? ([["Rejection reason", escapeHtml(r.rejectionReason)]] as [string, string][])
          : []),
        ["Themes", themesHtml(r)],
        ...(r.claimRecordId
          ? ([
              [
                "Normalised claim",
                `<code>${escapeHtml(r.claimRecordId)}</code> (shared by repeated occurrences)`,
              ],
            ] as [string, string][])
          : []),
        ...(r.occurrenceId
          ? ([["Occurrence", `<code>${escapeHtml(r.occurrenceId)}</code>`]] as [string, string][])
          : []),
        [
          "Source post",
          `<a href="${escapeHtml(traceLink(r))}">${escapeHtml(`${r.publicationId}/${r.postId}`)}</a> · <code>${escapeHtml(r.sourceVersion)}</code>`,
        ],
        ...(r.modelVersion
          ? ([
              [
                "Extraction",
                escapeHtml(`${r.modelVersion} · ${r.promptVersion ?? ""} · ${r.extractedAt ?? ""}`),
              ],
            ] as [string, string][])
          : []),
      ];
      return `<p><a href="/claims">All claims</a></p>
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
    },
  };
  return [list, detail];
}
