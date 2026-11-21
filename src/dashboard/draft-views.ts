import type { DraftEntry, DraftInventoryPort } from "./drafts.js";
import { escapeHtml, type DashboardView } from "./server.js";

/** Draft inventory pages (#440): read-only, bounded, escaped. */

const STATUS_LABEL: Record<DraftEntry["status"], [string, string]> = {
  approved: ["done", "verification approved"],
  redraft: ["failed", "rejected / unresolved"],
  unverified: ["not-started", "unverified"],
  unreadable: ["unknown", "unreadable"],
};
const badge = (e: DraftEntry) => {
  const [css, text] = STATUS_LABEL[e.status];
  return `<span class="s-${css}">${escapeHtml(text)}</span>`;
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
const viewLink = (path: string) => `/drafts/view?path=${encodeURIComponent(path)}`;
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
            `<tr><td>${escapeHtml(e.draftedAt?.slice(0, 16).replace("T", " ") ?? "unknown")}</td><td><a href="${escapeHtml(viewLink(e.path))}">${escapeHtml(e.title ?? `${e.publicationId}/${e.postId}`)}</a></td><td>${escapeHtml(e.postId)}</td><td>${badge(e)}</td><td>${delivery(e)}</td></tr>`,
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
<div class="wrap"><table><thead><tr><th>Saved</th><th>Draft</th><th>Post</th><th>Verification</th><th>Delivery</th></tr></thead>
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
        ...(e.title ? ([["Title", escapeHtml(e.title)]] as [string, string][]) : []),
        ["Verification", badge(e)],
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
<dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
${found.markdown !== undefined ? `<h2>Draft text</h2><p>Shown as text; its markup is never executed.</p><pre>${escapeHtml(found.markdown)}</pre>` : ""}`;
    },
  };
  return [list, view];
}
