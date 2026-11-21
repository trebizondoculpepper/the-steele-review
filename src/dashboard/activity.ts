import type { RecentArticlesPort, RunStatusPort, RunState, StageName } from "./articles.js";

/**
 * Read-only activity feed for the console (#479).
 *
 * Article-stage lifecycle comes from the workflow status the dashboard already
 * reads; process lifecycle is not inferred from silence, so a component with
 * no fresh observation is reported as unknown rather than "stopped" or
 * "completed". Errors are reported by category only: never a stack, prompt,
 * payload or provider body.
 */

export type ActivityState = "started" | "completed" | "failed" | "unknown";
export type ActivityKind = "article-stage";

export interface ActivityEvent {
  /** When the observation applies; absent when the source did not report one. */
  at?: string;
  kind: ActivityKind;
  /** Logical component or stage, e.g. "drafting". */
  component: string;
  /** Source/run correlation the operator can follow. */
  publicationId?: string;
  postId?: string;
  state: ActivityState;
  /** Sanitised error category, never a message from the provider. */
  errorCategory?: string;
  /** Where the operator can inspect the run. */
  link?: string;
}

export interface ActivityInput {
  articles: Pick<RecentArticlesPort, "recent">;
  runs: RunStatusPort;
  /** How many recent articles to observe. */
  limit?: number;
}

export const ACTIVITY_PAGE_SIZE = 25;

const STAGE_ORDER: readonly string[] = [
  "capture",
  "themes",
  "claims",
  "research",
  "drafting",
  "verification",
  "delivery",
];

/** Failure categories are mapped to a closed set; anything else stays generic. */
function categoryOf(reason: string): string {
  if (/credit|402/i.test(reason)) return "provider-credit";
  if (/auth|401|403/i.test(reason)) return "provider-auth";
  if (/timeout|deadline/i.test(reason)) return "timeout";
  if (/malformed|invalid/i.test(reason)) return "invalid-result";
  if (/unavailable|unreachable|connect/i.test(reason)) return "unavailable";
  return "failed";
}

/** Bounded events for one run, oldest stage first. */
function eventsFor(
  run: RunState,
  post: { publicationId: string; postId: string },
): ActivityEvent[] {
  const link = `/articles/trace?publication=${encodeURIComponent(post.publicationId)}&post=${encodeURIComponent(post.postId)}`;
  const base = {
    kind: "article-stage" as const,
    publicationId: post.publicationId,
    postId: post.postId,
    link,
  };
  if (run.state === "not-configured" || run.state === "unavailable")
    return [{ ...base, component: "article-run", state: "unknown" }];
  if (run.state === "not-started") return [];
  if (run.state === "running") {
    const stage = run.progress?.stage;
    const at = run.progress?.at;
    return [
      {
        ...base,
        component: stage && STAGE_ORDER.includes(stage as StageName) ? stage : "article-run",
        state: "started",
        ...(at ? { at } : {}),
      },
    ];
  }
  const final = run.result;
  const at = "at" in final && typeof final.at === "string" ? final.at : undefined;
  if (final.outcome === "failed") {
    const reason = "reason" in final && typeof final.reason === "string" ? final.reason : "failed";
    return [
      {
        ...base,
        ...(at ? { at } : {}),
        component: "article-run",
        state: "failed",
        errorCategory: categoryOf(reason),
      },
    ];
  }
  return [{ ...base, ...(at ? { at } : {}), component: "article-run", state: "completed" }];
}

/** Recent article-stage activity, bounded and newest first. */
export async function collectActivity(input: ActivityInput): Promise<ActivityEvent[]> {
  const limit = input.limit ?? ACTIVITY_PAGE_SIZE;
  const articles = await input.articles.recent(limit);
  const out: ActivityEvent[] = [];
  for (const article of articles) {
    const post = { publicationId: article.publicationId, postId: article.postId };
    let run: RunState;
    try {
      run = await input.runs.status({ ...post, sourceVersion: article.sourceVersion });
    } catch {
      run = { state: "unavailable" };
    }
    out.push(...eventsFor(run, post));
  }
  return out.slice(0, limit);
}

/** Escape untrusted text for the HTML activity table. */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Read-only activity page body. Everything is escaped; links are internal. */
export function renderActivity(events: readonly ActivityEvent[]): string {
  if (events.length === 0)
    return '<p class="empty">No recent activity has been observed.</p>';
  const rows = events
    .map((e) => {
      const correlation = [e.publicationId, e.postId].filter(Boolean).join("/");
      const detail = e.errorCategory ? esc(e.errorCategory) : "—";
      const at = e.at ? esc(e.at) : "unknown time";
      return `<tr><td>${at}</td><td>${esc(e.component)}</td><td>${esc(correlation)}</td><td>${e.state}</td><td>${detail}</td><td>${
        e.link ? `<a href="${esc(e.link)}">inspect</a>` : "—"
      }</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>Time</th><th>Component</th><th>Source</th><th>State</th><th>Error</th><th>Run</th></tr></thead><tbody>${rows}</tbody></table>`;
}
