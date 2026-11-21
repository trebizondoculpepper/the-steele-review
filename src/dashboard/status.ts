import { escapeHtml, type DashboardView } from "./server.js";

/**
 * System status page (#376).
 *
 * Renders the same read-only facts as the `status` command, plus the last
 * discovery poll, archive progress and index catch-up. Every value is a
 * sanitised state or count; the page never shows endpoints, credentials or
 * source text. A source that is not configured, cannot be reached, or has not
 * reported recently is labelled rather than hidden.
 */

export type ServiceState = "healthy" | "unavailable" | "not-configured";
export type FeedPollState =
  | "current"
  | "stale"
  | "no-poll-yet"
  | "unavailable"
  | "not-configured";
export type ArchiveState = "ok" | "unavailable" | "not-configured";
export type IndexState =
  | "current"
  | "behind"
  | "pending"
  | "incomplete"
  | "unavailable"
  | "not-configured";

export interface StatusSnapshot {
  /** When the snapshot was collected; each source was bounded around this time. */
  observedAt: string;
  services: Array<{ name: string; state: ServiceState }>;
  /** Pipeline counts from the state controller, when it was readable. */
  operations: Array<{ status: string; count: number }>;
  feedPoll: { state: FeedPollState; at?: string };
  archive: { state: ArchiveState; captured?: number; truncated?: boolean };
  indexCatchUp: { state: IndexState; pendingChanges?: number };
}

export interface StatusSource {
  read(): Promise<StatusSnapshot>;
}

/** Default age after which a poll report is considered stale. */
export const DEFAULT_STALE_AFTER_MS = 30 * 60_000;

const TONE: Record<string, string> = {
  healthy: "done",
  ok: "done",
  current: "done",
  stale: "pending",
  behind: "pending",
  pending: "pending",
  incomplete: "pending",
  unavailable: "failed",
  "not-configured": "unknown",
  "no-poll-yet": "unknown",
};

const badge = (state: string) =>
  `<span class="s-${escapeHtml(TONE[state] ?? "unknown")}">${escapeHtml(state)}</span>`;

const time = (iso?: string) =>
  iso ? `<code>${escapeHtml(iso)}</code>` : '<span class="empty">never</span>';

export function statusView(source: StatusSource): DashboardView {
  return {
    path: "/status",
    title: "Status",
    async render() {
      let snapshot: StatusSnapshot;
      try {
        snapshot = await source.read();
      } catch {
        return '<p class="empty">System status is unavailable: no source could be read.</p>';
      }
      const services = snapshot.services
        .map((s) => `<tr><td>${escapeHtml(s.name)}</td><td>${badge(s.state)}</td></tr>`)
        .join("");
      const operations =
        snapshot.operations.length === 0
          ? '<p class="empty">No operations recorded yet.</p>'
          : `<div class="wrap"><table><thead><tr><th>Operation status</th><th>Count</th></tr></thead><tbody>${snapshot.operations
              .map(
                (o) => `<tr><td>${escapeHtml(o.status)}</td><td>${o.count}</td></tr>`,
              )
              .join("")}</tbody></table></div>`;
      const archive =
        snapshot.archive.state === "ok"
          ? `${snapshot.archive.captured ?? 0} captured${snapshot.archive.truncated ? " (scan truncated)" : ""}`
          : badge(snapshot.archive.state);
      const index =
        snapshot.indexCatchUp.state === "behind"
          ? `${badge("behind")} ${snapshot.indexCatchUp.pendingChanges ?? 0} change(s) pending`
          : snapshot.indexCatchUp.state === "current"
            ? badge("current")
            : badge(snapshot.indexCatchUp.state);
      const feedPoll =
        snapshot.feedPoll.at === undefined
          ? badge(snapshot.feedPoll.state)
          : `${badge(snapshot.feedPoll.state)} last poll ${time(snapshot.feedPoll.at)}`;
      return `<p>Observed at ${time(snapshot.observedAt)}. Each source is independent: a failure in one does not hide another.</p>
<h2>Services</h2>
<div class="wrap"><table><thead><tr><th>Component</th><th>Check</th></tr></thead><tbody>${services}</tbody></table></div>
<h2>Pipeline</h2>
${operations}
<h2>Capture and indexing</h2>
<div class="wrap"><table><thead><tr><th>Check</th><th>Observation</th></tr></thead><tbody>
<tr><td>Feed poll</td><td>${feedPoll}</td></tr>
<tr><td>Archive</td><td>${archive}</td></tr>
<tr><td>Index catch-up</td><td>${index}</td></tr>
</tbody></table></div>`;
    },
  };
}
