import type { ArchivedArticle, RunByKeyPort, RunState } from "./articles.js";
import { escapeHtml } from "./server.js";

/**
 * "Running now" on Overview (#522): the article workflows that are active at
 * this moment, with their current stage, without opening each article.
 *
 * Active runs come from one bounded query of Restate's invocation table, so
 * the page never fetches every run individually. Each active run's stage and
 * last progress come from the run's own durable progress (#439), through the
 * same typed status port the Activity page uses (#479). Read-only: opening
 * Overview submits nothing and calls no model. Only allowlisted operational
 * fields are shown, and every value is escaped.
 */

/** How Restate reports an unfinished invocation, reduced to what an operator needs. */
export type ActiveState = "running" | "queued" | "waiting" | "retrying";

export interface ActiveInvocation {
  /** The ArticleRun workflow key: `pub/post@<32 hex>` plus optional suffixes. */
  key: string;
  /** Restate invocation ID, for the console link. */
  invocationId: string;
  state: ActiveState;
  /** When Restate created the invocation. */
  createdAt?: string;
  /** When Restate last changed the invocation. */
  modifiedAt?: string;
}

export interface ActiveRunsPort {
  /** Unfinished ArticleRun invocations, newest first; throws when unavailable. */
  active(limit: number): Promise<ActiveInvocation[]>;
}

export interface RunningNowInput {
  active: ActiveRunsPort;
  articles: { find(publicationId: string, postId: string): Promise<ArchivedArticle | undefined> };
  /** Status of the invocation's exact workflow key: attempts and recoveries as themselves. */
  runs: RunByKeyPort;
  /** Restate console link for one invocation, when configured. */
  invocationLink?: (id: string) => string | undefined;
  /** Progress older than this is reported as stale. */
  staleAfterMs?: number;
  limit?: number;
  now?: () => Date;
}

export interface RunningRow {
  publicationId: string;
  postId: string;
  title?: string;
  state: ActiveState;
  /** The run's own current stage, when it has reported one. */
  stage?: string;
  startedAt?: string;
  lastProgressAt?: string;
  /** No progress for longer than the stale threshold. */
  stale: boolean;
  traceLink: string;
  consoleLink?: string;
}

export type RunningNow =
  | { state: "ok"; rows: RunningRow[]; truncated: boolean }
  | { state: "unavailable" };

export const RUNNING_LIMIT = 20;
export const DEFAULT_RUNNING_STALE_MS = 30 * 60_000;
const CONCURRENCY = 5;

const RUN_KEY =
  /^([a-z0-9][a-z0-9-]{0,199})\/([a-z0-9][a-z0-9-]{0,199})@([0-9a-f]{32})(?:~[a-z0-9-]{1,80})*$/;

/** Restate invocation status, mapped to an honest operator label. */
export function activeStateOf(status: string): ActiveState | undefined {
  switch (status) {
    case "running":
    case "ready":
      return "running";
    case "pending":
    case "scheduled":
    case "inboxed":
      return "queued";
    case "suspended":
    case "paused":
      return "waiting";
    case "backing-off":
      return "retrying";
    default:
      return undefined; // completed, or a status this page does not know
  }
}

/** Active article runs, newest first. */
export async function collectRunningNow(input: RunningNowInput): Promise<RunningNow> {
  const limit = input.limit ?? RUNNING_LIMIT;
  let invocations: ActiveInvocation[];
  try {
    // One more than shown, to say when the list is cut short.
    invocations = await input.active.active(limit + 1);
  } catch {
    return { state: "unavailable" };
  }
  const truncated = invocations.length > limit;
  const now = (input.now ?? (() => new Date()))().getTime();
  const staleAfter = input.staleAfterMs ?? DEFAULT_RUNNING_STALE_MS;

  const candidates = invocations.slice(0, limit).flatMap((inv) => {
    const m = RUN_KEY.exec(inv.key);
    return m ? [{ inv, publicationId: m[1]!, postId: m[2]!, prefix: m[3]! }] : [];
  });
  const rows: RunningRow[] = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const observed = await Promise.all(
      batch.map(async ({ inv, publicationId, postId, prefix }) => {
        let article: ArchivedArticle | undefined;
        try {
          article = await input.articles.find(publicationId, postId);
        } catch {
          article = undefined;
        }
        // Progress of this exact invocation's key, so an active recovery or a
        // later attempt is never replaced by its finished parent (#522).
        let run: RunState | undefined;
        try {
          run = await input.runs.byKey(inv.key);
        } catch {
          run = undefined;
        }
        // The title is shown only when the index holds the revision this run is keyed by.
        if (article && article.sourceVersion.slice(7, 39) !== prefix) article = undefined;
        // A run that has finished since the query is no longer running.
        if (run && run.state === "finished") return undefined;
        const progress = run?.state === "running" ? run.progress : undefined;
        const lastProgressAt = progress?.at ?? inv.modifiedAt;
        const last = lastProgressAt ? Date.parse(lastProgressAt) : Number.NaN;
        const row: RunningRow = {
          publicationId,
          postId,
          ...(article?.title ? { title: article.title } : {}),
          state: inv.state,
          ...(progress?.stage ? { stage: progress.stage } : {}),
          ...(inv.createdAt ? { startedAt: inv.createdAt } : {}),
          ...(lastProgressAt ? { lastProgressAt } : {}),
          // Queued work has not started, so silence is not staleness.
          stale: inv.state !== "queued" && (Number.isNaN(last) || now - last > staleAfter),
          traceLink: `/articles/trace?publication=${encodeURIComponent(publicationId)}&post=${encodeURIComponent(postId)}`,
        };
        const consoleLink = input.invocationLink?.(inv.invocationId);
        return consoleLink ? { ...row, consoleLink } : row;
      }),
    );
    for (const row of observed) if (row) rows.push(row);
  }
  return { state: "ok", rows, truncated };
}

const LABEL: Record<ActiveState, string> = {
  running: "running",
  queued: "queued, not started",
  waiting: "waiting",
  retrying: "retrying after a failure",
};
const TONE: Record<ActiveState, string> = {
  running: "pending",
  queued: "unknown",
  waiting: "unknown",
  retrying: "failed",
};

const time = (iso?: string) =>
  iso ? `<code>${escapeHtml(iso)}</code>` : '<span class="empty">not reported</span>';

/** The "Running now" section body. Every value is escaped; links are internal or the validated console. */
export function renderRunningNow(running: RunningNow): string {
  if (running.state === "unavailable")
    return '<h2>Running now</h2><p class="empty">Running workflows are unavailable: Restate could not be queried, so this is not a statement that nothing is running.</p>';
  if (running.rows.length === 0)
    return '<h2>Running now</h2><p class="empty">No article workflows are running.</p>';
  const rows = running.rows
    .map((r) => {
      const source = escapeHtml(`${r.publicationId}/${r.postId}`);
      const title = r.title ? `${escapeHtml(r.title)}<br><small>${source}</small>` : source;
      const stale = r.stale ? ' <span class="s-pending">stale</span>' : "";
      const links = [
        `<a href="${escapeHtml(r.traceLink)}">article</a>`,
        ...(r.consoleLink
          ? [
              `<a href="${escapeHtml(r.consoleLink)}" target="_blank" rel="noopener noreferrer">run</a>`,
            ]
          : []),
      ].join(" · ");
      return `<tr><td>${title}</td><td><span class="s-${TONE[r.state]}">${escapeHtml(LABEL[r.state])}</span>${stale}</td><td>${
        r.stage ? escapeHtml(r.stage) : '<span class="empty">not reported</span>'
      }</td><td>${time(r.startedAt)}</td><td>${time(r.lastProgressAt)}</td><td>${links}</td></tr>`;
    })
    .join("");
  const more = running.truncated
    ? `<p class="limitation">Showing the newest ${running.rows.length} active runs; more are active.</p>`
    : "";
  return `<h2>Running now</h2><div class="wrap"><table><thead><tr><th>Article</th><th>State</th><th>Stage</th><th>Started</th><th>Last progress</th><th>Links</th></tr></thead><tbody>${rows}</tbody></table></div>${more}`;
}

const STATUS = /^[a-z-]{1,30}$/;
const INVOCATION = /^inv_[A-Za-z0-9]{10,100}$/;
const ISO = (v: unknown) =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined;

/**
 * Unfinished ArticleRun invocations from Restate's admin query API, in one
 * bounded query. Any failure throws, so the page reports "unavailable" rather
 * than an empty list.
 */
export function restateActiveRuns(
  adminUrl: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): ActiveRunsPort {
  const f = options.fetch ?? fetch;
  const base = adminUrl.replace(/\/+$/, "");
  return {
    async active(limit) {
      const n = Math.max(1, Math.min(Math.trunc(limit), 200));
      const res = await f(`${base}/query`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          query: `SELECT id, target_service_key AS key, status, created_at, modified_at FROM sys_invocation WHERE target_service_name = 'ArticleRun' AND target_handler_name = 'run' AND status != 'completed' ORDER BY created_at DESC LIMIT ${n}`,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!res.ok) throw new Error("restate query failed");
      const body = (await res.json()) as { rows?: Record<string, unknown>[] };
      return (body.rows ?? []).flatMap((row) => {
        const status = typeof row.status === "string" && STATUS.test(row.status) ? row.status : "";
        const state = activeStateOf(status);
        if (
          !state ||
          typeof row.key !== "string" ||
          typeof row.id !== "string" ||
          !INVOCATION.test(row.id)
        )
          return [];
        const createdAt = ISO(row.created_at);
        const modifiedAt = ISO(row.modified_at);
        return [
          {
            key: row.key,
            invocationId: row.id,
            state,
            ...(createdAt ? { createdAt } : {}),
            ...(modifiedAt ? { modifiedAt } : {}),
          },
        ];
      });
    },
  };
}
