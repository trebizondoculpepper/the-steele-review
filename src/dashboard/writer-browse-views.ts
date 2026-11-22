import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { renderWriterAttemptText } from "../drafting/writer-attempts.js";
import { WriterPackageSchema } from "../drafting/writer-package.js";
import {
  CollectionQueryError,
  collectionQueryFromParams,
  queryCollection,
} from "./collection-query.js";
import { escapeHtml, type DashboardView } from "./server.js";
import { attemptRecord, writerCollection, type WriterBrowseRow } from "./writer-collection.js";

/**
 * Writer records search (#623): briefs and retained writer attempts, read
 * only. Raw provider output appears only on the private attempt page,
 * escaped and bounded; never in lists, status or logs.
 */

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;
/** Bound on raw output shown on the attempt page. */
export const RAW_DISPLAY_CHARS = 20_000;
const ATTEMPT_ID = /^(?:writer|editorial)-attempt-[0-9a-f]{32}$/;
const BRIEF = /^writer-packages\/[^/]+\/[^/]+\/[^/]+\.json$/;
const refText = (r: { commit: string; path: string }) =>
  `<code>${escapeHtml(`${r.commit.slice(0, 12)}:${r.path}`)}</code>`;

export function writerBrowseViews(content?: Store): DashboardView[] {
  const list: DashboardView = {
    path: "/writer/search",
    title: "Writer records",
    async render(url) {
      if (!content)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const raw = collectionQueryFromParams(url);
      const f = (raw.filters ?? {}) as Record<string, string>;
      const kind = f.kind === "brief" ? "brief" : "attempt";
      const q = (raw.text ?? "").slice(0, 200);
      const outcomes =
        kind === "brief"
          ? ["ready", "evidence-gap"]
          : ["accepted", "rejected", "returned", "no-response", "interrupted"];
      const form = `<form method="get" action="/writer/search"><label>Text <input name="q" value="${escapeHtml(q)}" maxlength="200"></label> <label>Records <select name="f.kind"><option value="attempt"${kind === "attempt" ? " selected" : ""}>writer attempts</option><option value="brief"${kind === "brief" ? " selected" : ""}>writer briefs</option></select></label> <label>Outcome <select name="f.outcome"><option value="">any</option>${outcomes
        .map((o) => `<option value="${o}"${f.outcome === o ? " selected" : ""}>${o}</option>`)
        .join("")}</select></label>${
        kind === "brief"
          ? ` <label>Post <input name="f.post" value="${escapeHtml(f.post ?? "")}" maxlength="600" placeholder="publication/post"></label>`
          : ""
      } <button>Search</button></form>`;
      let page;
      try {
        page = await queryCollection(writerCollection(content), raw);
      } catch (error) {
        if (error instanceof CollectionQueryError)
          return `${form}<p class="empty">That filter is not valid for writer records.</p>`;
        return `${form}<p class="empty">Saved writer records are unavailable right now.</p>`;
      }
      const notes = page.limitations.map((l) => `<p class="empty">${escapeHtml(l)}</p>`).join("");
      const rows = (page.rows as WriterBrowseRow[])
        .map((r) => {
          if (r.kind === "brief") {
            const link = `/writer/brief?${new URLSearchParams({ path: r.id }).toString()}`;
            return `<tr><td><a href="${escapeHtml(link)}">${escapeHtml(r.summary)}</a></td><td>${escapeHtml(r.outcome)}</td><td>${escapeHtml(String(r.claims ?? 0))} claims</td><td>${refText(r.artifact)}</td></tr>`;
          }
          const a = r.attempt!;
          const link = `/writer/attempt?${new URLSearchParams({ id: r.id }).toString()}`;
          return `<tr><td><a href="${escapeHtml(link)}">${escapeHtml(r.summary)}</a><br><span class="empty">${escapeHtml(r.publicationId && r.postId ? `${r.publicationId}/${r.postId}` : a.package)}</span></td><td>${escapeHtml(r.outcome)}${a.failure ? ` (${escapeHtml(a.failure)})` : ""}${a.stopReason === "length-limit" ? " · truncated" : ""}${a.hasDiagnostic ? " · diagnostic" : ""}</td><td>${escapeHtml(a.model)}</td><td>${refText(r.artifact)}</td></tr>`;
        })
        .join("");
      const params = new URLSearchParams(url.searchParams);
      params.delete("after");
      const next = page.next
        ? `<p><a href="/writer/search?${escapeHtml(new URLSearchParams([...params, ["after", page.next]]).toString())}">Continue</a></p>`
        : "";
      if (page.rows.length === 0)
        return `${form}${notes}<p class="empty">No matching ${kind === "brief" ? "briefs" : "attempts"} on this page.</p>${next}`;
      const head =
        kind === "brief"
          ? "<th>Post</th><th>Status</th><th>Claims</th><th>Saved brief</th>"
          : "<th>Attempt</th><th>Outcome</th><th>Model</th><th>Saved record</th>";
      return `${form}${notes}<p>Saved writer evidence briefs and every retained writer call. Search never reruns or rescues anything.</p><div class="wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>${next}`;
    },
  };

  const attempt: DashboardView = {
    path: "/writer/attempt",
    title: "Writer attempt",
    hidden: true,
    async render(url) {
      if (!content)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const id = url.searchParams.get("id") ?? "";
      if (!ATTEMPT_ID.test(id)) return '<p class="empty">Choose an attempt from the list.</p>';
      const found = await attemptRecord(content, id).catch(() => undefined);
      if (!found) return '<p class="empty">This attempt could not be read.</p>';
      const a = found.manifest;
      const facts: [string, string][] = [
        ["Attempt", `<code>${escapeHtml(a.attemptId)}</code>`],
        [
          "Kind",
          escapeHtml(`${a.kind} ${a.number}${a.revision ? ` (revision ${a.revision})` : ""}`),
        ],
        ["Outcome", escapeHtml(`${a.outcome}${a.failure ? ` (${a.failure})` : ""}`)],
        ["Completion", escapeHtml(a.completion.stopReason)],
        ["Requested model", escapeHtml(a.requestedModel)],
        ["Prompt", `<code>${escapeHtml(a.promptVersion)}</code>`],
        ...(a.repairPromptVersion
          ? ([["Repair prompt", `<code>${escapeHtml(a.repairPromptVersion)}</code>`]] as [
              string,
              string,
            ][])
          : []),
        ["Brief (package)", refText(a.package)],
        ["Request", refText(a.input)],
        ["Source", refText(a.source)],
        ...(a.diagnostic ? ([["Diagnostic", refText(a.diagnostic)]] as [string, string][]) : []),
        ["Saved record", refText(found.ref)],
      ];
      let rawHtml = '<p class="empty">No response text was retained for this attempt.</p>';
      if (a.raw) {
        try {
          const text = await content.read({ ...a.raw, sha256: a.raw.hash.replace(/^sha256:/, "") });
          rawHtml = `<h2>Response (private, escaped)</h2>${
            text.length > RAW_DISPLAY_CHARS
              ? `<p class="empty">Showing the first ${RAW_DISPLAY_CHARS} of ${text.length} characters.</p>`
              : ""
          }${renderWriterAttemptText(text.slice(0, RAW_DISPLAY_CHARS))}`;
        } catch {
          rawHtml = '<p class="empty">The retained response could not be read exactly.</p>';
        }
      }
      return `<p><a href="/writer/search">All writer records</a></p><dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>${rawHtml}`;
    },
  };

  const brief: DashboardView = {
    path: "/writer/brief",
    title: "Writer brief",
    hidden: true,
    async render(url) {
      if (!content)
        return '<p class="empty">The content repository is not configured for the dashboard.</p>';
      const path = url.searchParams.get("path") ?? "";
      if (!BRIEF.test(path)) return '<p class="empty">Choose a brief from the list.</p>';
      try {
        const r = await content.lookup(path);
        if (!r) return '<p class="empty">This brief could not be found.</p>';
        const pkg = WriterPackageSchema.parse(JSON.parse(await content.read(r)));
        const claims = pkg.claims
          .map(
            (c) =>
              `<li>${escapeHtml(c.statement)} <span class="empty">(${escapeHtml(c.status)}, ${c.evidence.length} evidence item(s))</span></li>`,
          )
          .join("");
        return `<p><a href="/writer/search?f.kind=brief">All writer briefs</a></p><dl><dt>Post</dt><dd>${escapeHtml(`${pkg.post.publicationId}/${pkg.post.postId}`)}</dd><dt>Status</dt><dd>${escapeHtml(pkg.status)}</dd><dt>Saved brief</dt><dd>${refText(r)}</dd></dl><h2>Claims</h2><ul>${claims}</ul>`;
      } catch {
        return '<p class="empty">This brief could not be read.</p>';
      }
    },
  };
  return [list, attempt, brief];
}
