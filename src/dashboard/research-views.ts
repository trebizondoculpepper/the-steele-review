import type { ResearchCitation, ResearchKind, ResearchPort, ResearchRow } from "./research.js";
import { escapeHtml, type DashboardView } from "./server.js";

/** Read-only Research pages (#507). */

const KIND_LABEL: Record<ResearchKind, string> = {
  dossier: "dossier (librarian-curated)",
  "imported-report": "imported report",
  "generated-report": "generated research report",
};
const KINDS = Object.keys(KIND_LABEL) as ResearchKind[];
const NOT_CONFIGURED =
  '<p class="empty">The content repository is not configured for the dashboard.</p>';
const detailLink = (r: { path: string; commit: string }) =>
  `/research/view?${new URLSearchParams({ path: r.path, at: r.commit })}`;
const external = (url: string) =>
  /^https?:\/\//i.test(url)
    ? `<a href="${escapeHtml(url)}" rel="noreferrer noopener">${escapeHtml(url)}</a>`
    : escapeHtml(url);

const SUPPORT_LABEL: Record<string, string> = {
  supported: "an archived passage supports the attributed finding",
  unverified: "retrieved, but support is topical or uncertain (not verified evidence)",
  "not-checked": "no support check ran (not verified evidence)",
};
const citationHtml = (c: ResearchCitation, claims: Map<string, string>) => {
  const status = [
    c.retrieval ? `retrieval: ${c.retrieval}` : "",
    c.support
      ? (SUPPORT_LABEL[c.support] ?? `${c.support} (not verified evidence)`)
      : "no support check recorded (not verified evidence)",
  ].filter(Boolean);
  if (c.sourceType === "monitored-source") {
    // Not independent support, whatever its passage check said.
    status.splice(1);
    status.unshift(
      "monitored source: the claimant's own material, quoted for attribution, not independent support",
    );
  } else if (c.sourceType) {
    status.unshift(`source type: ${c.sourceType}`);
  }
  if (c.confidenceRationale) status.push(`rationale: ${c.confidenceRationale}`);
  return `<li>${c.title ? `${escapeHtml(c.title)}<br>` : ""}${external(c.url)}${status.length ? `<br><span class="empty">${escapeHtml(status.join("; "))}</span>` : ""}${c.passages.map((p) => `<blockquote>${escapeHtml(p.passage)}</blockquote>${p.claimRecordId ? `<span class="empty">checked against: ${escapeHtml(claims.get(p.claimRecordId) ?? "a claim not in the saved request")} <code>${escapeHtml(p.claimRecordId)}</code></span>` : ""}`).join("")}</li>`;
};

export function researchViews(research?: ResearchPort): DashboardView[] {
  const list: DashboardView = {
    path: "/research",
    title: "Research",
    async render(url) {
      if (!research) return NOT_CONFIGURED;
      const q = (url.searchParams.get("q") ?? "").slice(0, 200);
      const kindRaw = url.searchParams.get("kind") ?? "";
      const kind = KINDS.find((k) => k === kindRaw);
      const after = url.searchParams.get("after") ?? undefined;
      const listing = await research.list({
        ...(q ? { query: q } : {}),
        ...(kind ? { kind } : {}),
        ...(after ? { after } : {}),
      });
      const option = (v: string, label: string) =>
        `<option value="${escapeHtml(v)}"${kindRaw === v ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const form = `<form method="get" action="/research"><label>Title or text <input name="q" value="${escapeHtml(q)}" maxlength="200"></label> <label>Kind <select name="kind">${option("", "all")}${KINDS.map((k) => option(k, KIND_LABEL[k])).join("")}</select></label> <button>Filter</button></form>`;
      if (listing.state === "unavailable") {
        return `${form}<p class="empty">Saved research is unavailable right now.</p>`;
      }
      const notes = [
        listing.partial
          ? "This page reached its scan bound before finding a full page of matches; continue to scan further."
          : "",
        listing.unreadable ? `${listing.unreadable} saved document(s) could not be read.` : "",
      ]
        .filter(Boolean)
        .map((n) => `<p class="empty">${escapeHtml(n)}</p>`)
        .join("");
      const next = new URLSearchParams({
        ...(q ? { q } : {}),
        ...(kind ? { kind } : {}),
        ...(listing.next ? { after: listing.next } : {}),
      });
      const more = listing.next
        ? `<p><a href="/research?${escapeHtml(next.toString())}">Continue</a>, saved documents in storage order.</p>`
        : "<p>End of the saved research.</p>";
      if (listing.rows.length === 0) {
        return `${form}${notes}<p class="empty">${q || kind ? "No saved research matches in this range." : "No saved research yet."}</p>${more}`;
      }
      const cites = (r: ResearchRow) =>
        r.citationCount === undefined
          ? '<span class="empty">not recorded</span>'
          : String(r.citationCount);
      const rows = listing.rows
        .map(
          (r) =>
            `<tr><td><a href="${escapeHtml(detailLink(r))}">${escapeHtml(r.title)}</a></td><td>${escapeHtml(KIND_LABEL[r.kind])}${r.outcome ? `<br><span class="empty">${escapeHtml(r.outcome)}</span>` : ""}</td><td>${r.subject ? escapeHtml(r.subject) : '<span class="empty">not recorded</span>'}</td><td>${r.date ? escapeHtml(r.date) : '<span class="empty">not recorded</span>'}</td><td>${cites(r)}</td></tr>`,
        )
        .join("");
      return `${form}${notes}<p>Saved research documents, read-only. Raw reports are kept apart from librarian-curated dossiers; a report existing does not mean it answers every claim, and a cited source is not verified evidence.</p>
<div class="wrap"><table><thead><tr><th>Title</th><th>Kind</th><th>Subject</th><th>Date</th><th>Citations</th></tr></thead><tbody>${rows}</tbody></table></div>${more}`;
    },
  };

  const detail: DashboardView = {
    path: "/research/view",
    title: "Research document",
    hidden: true,
    async render(url) {
      if (!research) return NOT_CONFIGURED;
      const path = url.searchParams.get("path") ?? "";
      const at = url.searchParams.get("at") ?? "";
      const d = await research.detail(path, at);
      if (!d) {
        return '<p><a href="/research">All research</a></p><p class="empty">That document version is missing or could not be read.</p>';
      }
      const facts: [string, string][] = [
        ["Kind", escapeHtml(KIND_LABEL[d.kind])],
        ["Subject", d.subject ? escapeHtml(d.subject) : '<span class="empty">not recorded</span>'],
        ["Date", d.date ? escapeHtml(d.date) : '<span class="empty">not recorded</span>'],
        [
          "Version",
          `<code>${escapeHtml(d.path)}</code> at commit <code>${escapeHtml(d.commit)}</code>, sha256 <code>${escapeHtml(d.hash)}</code>`,
        ],
      ];
      if (d.themeId) {
        facts.push(["Theme", `<code>${escapeHtml(d.themeId)}</code>`]);
      }
      if (d.kind === "generated-report") {
        facts.push(
          ["Research job", `<code>${escapeHtml(d.jobId ?? "")}</code>`],
          [
            "Outcome",
            d.outcome
              ? escapeHtml(`${d.outcome}${d.failure ? ` (${d.failure})` : ""}`)
              : '<span class="empty">no saved result</span>',
          ],
          [
            "Request",
            d.origin
              ? escapeHtml(`${d.origin}${d.question ? `: ${d.question}` : ""}`)
              : '<span class="empty">no readable request</span>',
          ],
        );
        if (d.model) facts.push(["Model", escapeHtml(d.model)]);
        if (d.post) {
          facts.push([
            "Source post",
            `<a href="${escapeHtml(`/articles/trace?${new URLSearchParams({ publication: d.post.publicationId, post: d.post.postId })}`)}">${escapeHtml(`${d.post.publicationId}/${d.post.postId}`)}</a>`,
          ]);
        }
        if (d.claims?.length) {
          facts.push([
            "Requested claims",
            `<ul>${d.claims.map((c) => `<li>${escapeHtml(c.statement)} <code>${escapeHtml(c.claimRecordId)}</code></li>`).join("")}</ul>`,
          ]);
        }
      }
      const claimStatements = new Map((d.claims ?? []).map((c) => [c.claimRecordId, c.statement]));
      const provenance = d.provenanceProblems?.length
        ? `<p class="empty">${escapeHtml(`Saved job records were ignored because they could not be bound to this report: ${d.provenanceProblems.join("; ")}.`)}</p>`
        : "";
      const citations =
        d.citations === undefined
          ? `<p class="empty">${d.kind === "imported-report" ? "This is an imported report: no structured citations were recorded. Any sources appear only as written in the text below and have not been checked." : "No citation record could be read for this document."}</p>`
          : d.citations.length === 0
            ? '<p class="empty">No citations recorded.</p>'
            : `<ol>${d.citations.map((c) => citationHtml(c, claimStatements)).join("")}</ol>${d.omittedCitations ? `<p class="empty">${d.omittedCitations} further citation(s) were omitted when saved.</p>` : ""}`;
      const gaps = d.gaps?.length
        ? `<h2>Recorded gaps</h2><ul>${d.gaps.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>`
        : "";
      return `<p><a href="/research">All research</a></p>
<h2>${escapeHtml(d.title)}</h2>
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<h2>Citations</h2>${provenance}${citations}${gaps}
<h2>Saved text</h2><p class="empty">Shown as saved Markdown source; links in it are not followed.</p>
<pre>${escapeHtml(d.text)}</pre>`;
    },
  };
  return [list, detail];
}
