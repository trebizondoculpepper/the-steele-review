import type { DraftEntry, DraftInventoryPort } from "./drafts.js";
import { escapeHtml, type DashboardView } from "./server.js";

/** Draft inventory pages (#440): read-only, bounded, escaped. */

const STATUS_LABEL: Record<DraftEntry["status"], [string, string]> = {
  approved: ["done", "verification approved"],
  redraft: ["failed", "rejected / unresolved"],
  unverified: ["not-started", "unverified"],
  incomplete: ["unknown", "verification incomplete"],
  unreadable: ["unknown", "unreadable"],
};
const badge = (e: DraftEntry) => {
  const [css, text] = STATUS_LABEL[e.status];
  return `<span class="s-${css}">${escapeHtml(e.approvalScope === "body-only" ? `body-only ${text}` : text)}</span>`;
};
const delivery = (e: DraftEntry) => {
  if (e.receipts.length === 0) return e.receiptsTruncated ? "receipt scan incomplete" : "none";
  return e.receipts
    .map((r) =>
      r.simulated
        ? `${escapeHtml(r.destination)} (simulated)`
        : r.url
          ? `<a href="${escapeHtml(r.url)}" rel="noopener noreferrer">${escapeHtml(r.destination)}</a> (delivered)`
          : `${escapeHtml(r.destination)} (delivered, unconfirmed link)`,
    )
    .join(", ");
};
const NOT_SAVED = '<span class="empty">not saved (this draft predates generated fields)</span>';
/** Title, subtitle and excerpt as saved with the draft (#456, #469); never invented. */
const fieldsSection = (e: DraftEntry) => {
  const value = (v?: string) =>
    v === undefined ? NOT_SAVED : `<span class="draft-text">${escapeHtml(v)}</span>`;
  return `<h2>Publication fields</h2>
<p class="empty">${e.approvalScope === "publication" ? "The verification result above covers these exact saved fields and body." : "No payload-aware verification is bound to these fields; any body-only result does not approve them."}</p>
<dl><dt>Title</dt><dd>${value(e.title)}</dd><dt>Subtitle</dt><dd>${value(e.subtitle)}</dd><dt>Excerpt</dt><dd>${value(e.excerpt)}</dd></dl>`;
};
const viewLink = (path: string) => `/drafts/view?path=${encodeURIComponent(path)}`;
const articleLink = (e: Pick<DraftEntry, "publicationId" | "postId">, id: string) =>
  `/drafts/article?${new URLSearchParams({ publication: e.publicationId, post: e.postId, id })}`;
/** Which article version a draft is, and whether that is the current one (#581). */
const versionCell = (e: DraftEntry) =>
  e.article
    ? `<a href="${escapeHtml(articleLink(e, e.article.id))}">version ${e.article.version}</a>${e.article.current ? " (current)" : ' <span class="empty">(older version)</span>'}`
    : '<span class="empty">not committed to an article</span>';
const ID = /^[a-z0-9][a-z0-9-]{0,299}$/;

export function draftViews(inventory?: DraftInventoryPort): DashboardView[] {
  const list: DashboardView = {
    path: "/drafts",
    title: "Drafts",
    async render(url) {
      if (!inventory)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const publicationId = url.searchParams.get("publication") ?? undefined;
      const postId = url.searchParams.get("post") ?? undefined;
      const after = url.searchParams.get("after") ?? undefined;
      const filter = {
        ...(publicationId && ID.test(publicationId) ? { publicationId } : {}),
        ...(postId && ID.test(postId) ? { postId } : {}),
      };
      const page = await inventory.page({ ...filter, ...(after ? { after } : {}) });
      if (page.entries.length === 0) {
        return '<p class="empty">No saved drafts were found in this range.</p>';
      }
      const rows = page.entries
        .map(
          (e) =>
            `<tr><td>${escapeHtml(e.draftedAt?.slice(0, 16).replace("T", " ") ?? "unknown")}</td><td><a href="${escapeHtml(viewLink(e.path))}">${escapeHtml(e.title ?? `${e.publicationId}/${e.postId}`)}</a></td><td>${escapeHtml(e.postId)}</td><td>${versionCell(e)}</td><td>${badge(e)}</td><td>${delivery(e)}</td></tr>`,
        )
        .join("");
      const query = new URLSearchParams({
        ...(filter.publicationId ? { publication: filter.publicationId } : {}),
        ...(filter.postId ? { post: filter.postId } : {}),
        ...(page.next ? { after: page.next } : {}),
      });
      const more = page.next
        ? `<p><a href="/drafts?${escapeHtml(query.toString())}">Next page</a> — this page is not the complete inventory.</p>`
        : "<p>End of the saved drafts in this range.</p>";
      return `<p>Saved drafts, newest storage order within each post. Approval is shown only where a verification report binds that exact draft.</p>
<div class="wrap"><table><thead><tr><th>Saved</th><th>Draft</th><th>Post</th><th>Article version</th><th>Verification</th><th>Delivery</th></tr></thead>
<tbody>${rows}</tbody></table></div>${more}`;
    },
  };

  const view: DashboardView = {
    path: "/drafts/view",
    title: "Draft",
    hidden: true,
    async render(url) {
      if (!inventory)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const path = url.searchParams.get("path") ?? "";
      const found = await inventory.text(path);
      if (!found) return '<p class="empty">Choose a draft from the list.</p>';
      const e = found.entry;
      const facts: [string, string][] = [
        ["Post", `${escapeHtml(e.publicationId)}/${escapeHtml(e.postId)}`],

        ["Article", versionCell(e)],
        ["Verification", badge(e)],
        ...(e.publicationHash
          ? ([["Publication payload", `<code>${escapeHtml(e.publicationHash)}</code>`]] as [
              string,
              string,
            ][])
          : []),
        ["Delivery", delivery(e)],
        ...(e.hash
          ? ([["Draft hash", `<code>${escapeHtml(e.hash)}</code>`]] as [string, string][])
          : []),
        ...(e.promptVersion
          ? ([["Prompt", `<code>${escapeHtml(e.promptVersion)}</code>`]] as [string, string][])
          : []),
        ...(e.modelVersion ? ([["Model", escapeHtml(e.modelVersion)]] as [string, string][]) : []),
        ...(e.limitation ? ([["Limitation", escapeHtml(e.limitation)]] as [string, string][]) : []),
      ];
      return `<p><a href="/drafts?${escapeHtml(new URLSearchParams({ publication: e.publicationId, post: e.postId }).toString())}">All drafts for this post</a></p>
<p><a href="/reviews?${escapeHtml(new URLSearchParams({ publication: e.publicationId, post: e.postId }).toString())}">Verifier history</a></p>
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
${fieldsSection(e)}
${found.markdown !== undefined ? `<h2>Body</h2><p>Shown as text; its markup is never executed.</p><pre class="draft-text">${escapeHtml(found.markdown)}</pre>` : ""}`;
    },
  };
  const article: DashboardView = {
    path: "/drafts/article",
    title: "Article history",
    hidden: true,
    async render(url) {
      if (!inventory)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const h = await inventory.article(
        url.searchParams.get("publication") ?? "",
        url.searchParams.get("post") ?? "",
        url.searchParams.get("id") ?? "",
      );
      if (!h) return '<p class="empty">Choose an article version from the drafts list.</p>';
      const current = h.versions.find((v) => v.current);
      const approvedNow = current?.entry.status === "approved";
      const olderApproved = h.versions.filter((v) => !v.current && v.entry.status === "approved");
      const summary = current
        ? `The current version is version ${current.version}, ${approvedNow ? "and that exact version is approved" : "and it is not approved"}.${olderApproved.length && !approvedNow ? ` An older version (${olderApproved.map((v) => v.version).join(", ")}) was approved; that approval does not carry over.` : ""}`
        : "The current canonical version could not be matched to a saved version.";
      const rows = h.versions
        .slice()
        .reverse()
        .map(
          (v) =>
            `<tr><td>${v.version}${v.current ? " (current)" : ""}</td><td><a href="${escapeHtml(viewLink(v.entry.path))}">${escapeHtml(v.entry.title ?? "untitled")}</a></td><td>${badge(v.entry)}</td><td>${escapeHtml(v.entry.draftedAt?.slice(0, 16).replace("T", " ") ?? "unknown")}</td><td><code>${escapeHtml(v.commit.slice(0, 12))}</code></td></tr>`,
        )
        .join("");
      return `<p><a href="/drafts?${escapeHtml(new URLSearchParams({ publication: h.publicationId, post: h.postId }).toString())}">All drafts for this post</a> · <a href="/reviews?${escapeHtml(new URLSearchParams({ publication: h.publicationId, post: h.postId }).toString())}">Verifier history</a></p>
<p>One logical article (<code>${escapeHtml(h.id)}</code>) for ${escapeHtml(`${h.publicationId}/${h.postId}`)}. Each version is a Git commit of the same document; earlier versions stay readable exactly as saved.</p>
<p>${escapeHtml(summary)}</p>
${h.unreadable ? `<p class="empty">${h.unreadable} version record(s) could not be read or ordered.</p>` : ""}
<div class="wrap"><table><thead><tr><th>Version</th><th>Draft</th><th>Verification</th><th>Saved</th><th>Commit</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    },
  };
  return [list, view, article];
}
