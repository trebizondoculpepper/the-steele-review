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

/**
 * Identifiers of runs that are recent or active, independent of when their
 * source post was published. Without this the feed can only see activity for
 * the newest source articles, so a run started today on an old post is
 * invisible.
 */
export interface RunIndexPort {
  recent(
    limit: number,
  ): Promise<Array<{ publicationId: string; postId: string; sourceVersion: string }>>;
}

export interface ActivityInput {
  articles: Pick<RecentArticlesPort, "recent">;
  runs: RunStatusPort;
  /** Optional run index: discovered runs are merged with the newest articles. */
  runIndex?: RunIndexPort;
  /** How many events to observe. */
  limit?: number;
}

export interface ActivityFeed {
  events: ActivityEvent[];
  /**
   * True when no run index was supplied, so discovery is limited to the newest
   * source articles and the page must say so.
   */
  discoveryLimited: boolean;
}

export const ACTIVITY_PAGE_SIZE = 25;
/** Status requests in flight at once. */
export const ACTIVITY_CONCURRENCY = 5;

const STAGE_ORDER: readonly string[] = [
  "capture",
  "themes",
  "claims",
  "research",
  "drafting",
  "verification",
  "delivery",
];

/**
 * Workflow progress names are not the dashboard's stage names: the producer
 * emits `package`, `draft`, `verify` and `recover`. Map them so the feed shows
 * a stage rather than a generic run.
 */
const PROGRESS_STAGE: Record<string, string> = {
  package: "drafting",
  draft: "drafting",
  verify: "verification",
  recover: "article-run",
  capture: "capture",
  themes: "themes",
  claims: "claims",
  research: "research",
  delivery: "delivery",
};

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
        component:
          stage === undefined
            ? "article-run"
            : (PROGRESS_STAGE[stage] ??
              (STAGE_ORDER.includes(stage as StageName) ? stage : "article-run")),
        state: "started",
        ...(at ? { at } : {}),
      },
    ];
  }
  // A recovered run reports the original failure with the recovery attached;
  // both are real activity and both must be visible.
  const recovery = run.recovery ? eventsFor(run.recovery, post) : [];
  const final = run.result;
  // The workflow stamps its own terminal time; nothing is inferred here.
  const at = typeof final.completedAt === "string" ? final.completedAt : undefined;
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
      ...recovery,
    ];
  }
  return [
    ...recovery,
    { ...base, ...(at ? { at } : {}), component: "article-run", state: "completed" },
  ];
}

/** Recent article-stage activity, newest observation first. */
export async function collectActivity(input: ActivityInput): Promise<ActivityFeed> {
  const limit = input.limit ?? ACTIVITY_PAGE_SIZE;
  const articles = await input.articles.recent(limit);

  // Merge run-index discovery with the newest articles, deduplicated by the
  // exact revision the workflow is keyed by.
  let targeted = articles.map((a) => ({
    publicationId: a.publicationId,
    postId: a.postId,
    sourceVersion: a.sourceVersion,
  }));
  if (input.runIndex) {
    const indexed = await input.runIndex.recent(limit);
    const seen = new Set(targeted.map((t) => `${t.publicationId}/${t.postId}@${t.sourceVersion}`));
    for (const run of indexed) {
      const key = `${run.publicationId}/${run.postId}@${run.sourceVersion}`;
      if (!seen.has(key)) {
        seen.add(key);
        targeted = [...targeted, run];
      }
    }
  }
  // Bounded concurrency: a slow or unreachable workflow endpoint must not
  // serialise the whole page, and must not open hundreds of sockets either.
  const out: ActivityEvent[] = [];
  for (let i = 0; i < targeted.length; i += ACTIVITY_CONCURRENCY) {
    const batch = targeted.slice(i, i + ACTIVITY_CONCURRENCY);
    const observed = await Promise.all(
      batch.map(async (target) => {
        const post = { publicationId: target.publicationId, postId: target.postId };
        let run: RunState;
        try {
          run = await input.runs.status(target);
        } catch {
          run = { state: "unavailable" };
        }
        return eventsFor(run, post);
      }),
    );
    for (const events of observed) out.push(...events);
  }
  // Newest observation first; an undated event sorts last rather than first.
  out.sort((a, b) => {
    // Work in progress first (#479): a just-started run may not have reported
    // a timestamp yet, and must not sort last and fall off the page.
    const live = Number(b.state === "started") - Number(a.state === "started");
    if (live !== 0) return live;
    const at = a.at === undefined ? Number.NEGATIVE_INFINITY : Date.parse(a.at);
    const bt = b.at === undefined ? Number.NEGATIVE_INFINITY : Date.parse(b.at);
    return bt - at;
  });
  return { events: out.slice(0, limit), discoveryLimited: input.runIndex === undefined };
}

/** Escape untrusted text for the HTML activity table. */
function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Read-only activity page body. Everything is escaped; links are internal. */
export function renderActivity(feed: ActivityFeed): string {
  const { events } = feed;
  const limitation = feed.discoveryLimited
    ? '<p class="limitation">Showing activity for the most recent source posts only: no run index is configured, so a run on an older post is not listed here.</p>'
    : "";
  if (events.length === 0)
    return `${limitation}<p class="empty">No recent activity has been observed.</p>`;
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
  const creditStopped = events.filter((e) => e.errorCategory === "provider-credit");
  const notice =
    creditStopped.length === 0
      ? ""
      : `<p class="warning" role="alert"><strong>Provider credit exhausted.</strong> ${creditStopped.length} run${
          creditStopped.length === 1 ? "" : "s"
        } stopped because the model provider's credit budget ran out. This is not a finding about any article. Affected runs: ${creditStopped
          .map(
            (e) =>
              `${esc(e.at ?? "unknown time")} ${esc([e.publicationId, e.postId].filter(Boolean).join("/"))}${
                e.link ? ` (<a href="${esc(e.link)}">run</a>)` : ""
              }`,
          )
          .join("; ")}.</p>`;
  return `${limitation}${notice}<table><thead><tr><th>Time</th><th>Component</th><th>Source</th><th>State</th><th>Error</th><th>Run</th></tr></thead><tbody>${rows}</tbody></table>`;
}
