import { describe, expect, it } from "vite-plus/test";
import type { ArchivedArticle, RunState } from "../../src/dashboard/articles.js";
import {
  collectRunningNow,
  renderRunningNow,
  restateActiveRuns,
  type ActiveInvocation,
} from "../../src/dashboard/running-now.js";
import { statusView, type StatusSnapshot } from "../../src/dashboard/status.js";

// Synthetic runs and fakes only: no Restate, index or model calls (#522).
const HEX = "0123456789abcdef0123456789abcdef";
const version = (n: number) => `sha256:${HEX}${String(n).padStart(32, "0")}`;
const now = new Date("2026-11-24T10:00:00.000Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const inv = (
  post: string,
  state: ActiveInvocation["state"],
  over: Partial<ActiveInvocation> = {},
) => ({
  key: `example/${post}@${HEX}`,
  invocationId: `inv_${post.replace(/-/g, "")}0000000000`,
  state,
  createdAt: ago(20),
  modifiedAt: ago(1),
  ...over,
});
const articles: Record<string, ArchivedArticle> = Object.fromEntries(
  ["drafting-run", "research-run", "queued-run", "waiting-run", "done-run", "stuck-run"].map(
    (p, i) => [
      p,
      { publicationId: "example", postId: p, title: `Title <${p}>`, sourceVersion: version(i) },
    ],
  ),
);
const states: Record<string, RunState> = {
  "drafting-run": { state: "running", progress: { stage: "draft", status: "running", at: ago(2) } },
  "research-run": {
    state: "running",
    progress: { stage: "research", status: "running", at: ago(3) },
  },
  "queued-run": { state: "not-started" },
  "waiting-run": {
    state: "running",
    progress: { stage: "research", status: "running", at: ago(5) },
  },
  "done-run": { state: "finished", result: { outcome: "delivered" } as never },
  "stuck-run": { state: "running", progress: { stage: "verify", status: "running", at: ago(90) } },
};
/** Exact keys with their own status, such as a recovery of a finished run. */
const byKey: Record<string, RunState> = {
  [`example/done-run@${HEX}~recover-credit`]: {
    state: "running",
    progress: { stage: "draft", status: "running", at: ago(1) },
  },
};
const input = (active: ActiveInvocation[] | Error, extra = {}) => ({
  active: {
    async active() {
      if (active instanceof Error) throw active;
      return active;
    },
  },
  articles: { find: async (_pub: string, post: string) => articles[post] },
  // Status by the exact workflow key: the post ID is its middle segment.
  runs: {
    byKey: async (key: string) =>
      byKey[key] ?? states[key.slice(key.indexOf("/") + 1, key.indexOf("@"))]!,
  },
  invocationLink: (id: string) => `https://console.example.test/ui/invocations/${id}`,
  now: () => now,
  ...extra,
});

describe("Running now on Overview (#522)", () => {
  it("shows concurrent runs with their current stages, and drops finished runs", async () => {
    const out = await collectRunningNow(
      input([
        inv("drafting-run", "running"),
        inv("research-run", "running"),
        inv("done-run", "running"),
      ]),
    );
    expect(out.state).toBe("ok");
    if (out.state !== "ok") return;
    expect(out.rows.map((r) => [r.postId, r.stage, r.state])).toEqual([
      ["drafting-run", "draft", "running"],
      ["research-run", "research", "running"],
    ]);
    expect(out.rows[0]!.lastProgressAt).toBe(ago(2));
    expect(out.rows[0]!.consoleLink).toMatch(/invocations\/inv_draftingrun/);
  });

  it("shows an active recovery by its own key, though its original run has finished", async () => {
    const out = await collectRunningNow(
      input([inv("done-run", "running", { key: `example/done-run@${HEX}~recover-credit` })]),
    );
    if (out.state !== "ok") throw new Error("unavailable");
    expect(out.rows.map((r) => [r.postId, r.stage, r.state])).toEqual([
      ["done-run", "draft", "running"],
    ]);
  });

  it("labels queued and waiting work honestly, and marks stale progress", async () => {
    const out = await collectRunningNow(
      input([
        inv("queued-run", "queued", { modifiedAt: ago(120) }),
        inv("waiting-run", "waiting"),
        inv("stuck-run", "running"),
      ]),
    );
    if (out.state !== "ok") throw new Error("unavailable");
    const by = Object.fromEntries(out.rows.map((r) => [r.postId, r]));
    // Queued work has not started: it is not stale, and has no stage.
    expect(by["queued-run"]).toMatchObject({ state: "queued", stale: false });
    expect(by["queued-run"]!.stage).toBeUndefined();
    expect(by["waiting-run"]).toMatchObject({ state: "waiting", stale: false });
    expect(by["stuck-run"]).toMatchObject({ state: "running", stage: "verify", stale: true });
    const html = renderRunningNow(out);
    expect(html).toContain("queued, not started");
    expect(html).toContain("waiting");
    expect(html).toContain(">stale<");
  });

  it("says when nothing is running, and when that cannot be established", async () => {
    expect(renderRunningNow(await collectRunningNow(input([])))).toContain(
      "No article workflows are running.",
    );
    const unavailable = renderRunningNow(await collectRunningNow(input(new Error("down"))));
    expect(unavailable).toContain("Running workflows are unavailable");
    expect(unavailable).toContain("not a statement that nothing is running");
  });

  it("escapes source text and says when the list is cut short", async () => {
    const out = await collectRunningNow(
      input([inv("drafting-run", "running"), inv("research-run", "running")], { limit: 1 }),
    );
    const html = renderRunningNow(out);
    expect(html).toContain("Title &lt;drafting-run&gt;");
    expect(html).not.toContain("<drafting-run>");
    expect(html).toContain("more are active");
  });

  it("appears on Overview, which refreshes itself, without hiding the status", async () => {
    const snapshot: StatusSnapshot = {
      observedAt: now.toISOString(),
      services: [],
      pipelineState: "healthy",
      operations: [],
      feedPoll: { state: "current" },
      archive: { state: "ok", captured: 1 },
      indexCatchUp: { state: "current" },
    };
    const view = statusView(
      { read: async () => snapshot },
      {
        runningNow: async () =>
          renderRunningNow(await collectRunningNow(input([inv("drafting-run", "running")]))),
      },
    );
    expect(view.refreshSeconds).toBe(15);
    const html = await view.render(new URL("http://dashboard.test/overview"));
    expect(html).toContain("<h2>Running now</h2>");
    expect(html).toContain("<h2>Services</h2>");
    // A failing Running now section does not hide the rest of Overview.
    const failing = statusView(
      { read: async () => snapshot },
      { runningNow: async () => Promise.reject(new Error("x")) },
    );
    const page = await failing.render(new URL("http://dashboard.test/overview"));
    expect(page).toContain("Running workflows are unavailable.");
    expect(page).toContain("<h2>Services</h2>");
  });
});

describe("active ArticleRun invocations from Restate's admin query (#522)", () => {
  const respond = (rows: unknown[], ok = true) =>
    (async () =>
      new Response(JSON.stringify({ rows }), { status: ok ? 200 : 500 })) as typeof fetch;

  it("maps Restate statuses and keeps only well-formed rows, in one bounded query", async () => {
    let body = "";
    const port = restateActiveRuns("http://admin.example.test/", {
      fetch: (async (_url: unknown, init?: RequestInit) => {
        body = String(init?.body);
        return respond([
          {
            id: "inv_aaaaaaaaaaaa",
            key: "k1",
            status: "running",
            created_at: ago(5),
            modified_at: ago(1),
          },
          { id: "inv_bbbbbbbbbbbb", key: "k2", status: "pending" },
          { id: "inv_cccccccccccc", key: "k3", status: "suspended" },
          { id: "inv_dddddddddddd", key: "k4", status: "backing-off" },
          { id: "inv_eeeeeeeeeeee", key: "k5", status: "completed" },
          { id: "not-an-id", key: "k6", status: "running" },
        ])();
      }) as typeof fetch,
    });
    const rows = await port.active(500);
    expect(rows.map((r) => [r.key, r.state])).toEqual([
      ["k1", "running"],
      ["k2", "queued"],
      ["k3", "waiting"],
      ["k4", "retrying"],
    ]);
    expect(JSON.parse(body).query).toMatch(/status != 'completed'.*LIMIT 200$/);
  });

  it("throws when Restate cannot be queried, so the page says unavailable", async () => {
    await expect(
      restateActiveRuns("http://admin.example.test", { fetch: respond([], false) }).active(5),
    ).rejects.toThrow();
  });
});
