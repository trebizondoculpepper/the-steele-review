import { describe, expect, it } from "vite-plus/test";
import type { RunState } from "../../src/dashboard/articles.js";
import { collectActivity, renderActivity } from "../../src/dashboard/activity.js";

const article = { publicationId: "pub", postId: "p1", sourceVersion: `sha256:${"a".repeat(64)}` };
const input = (run: RunState | Error) => ({
  articles: { recent: async () => [article] },
  runs: {
    status: async (): Promise<RunState> => {
      if (run instanceof Error) throw run;
      return run;
    },
  },
});

describe("console activity (#479)", () => {
  it("shows a running stage as started, never as completed", async () => {
    const { events } = await collectActivity(
      input({
        state: "running",
        progress: { stage: "drafting", status: "running", at: "2026-02-01T00:00:00Z" },
      }),
    );
    expect(events[0]).toMatchObject({
      component: "drafting",
      state: "started",
      at: "2026-02-01T00:00:00Z",
    });
  });

  it("shows a failed run with a sanitised error category", async () => {
    const { events } = await collectActivity(
      input({
        state: "finished",
        result: {
          outcome: "failed",
          reason: "credit-exhausted",
          completedAt: "2026-02-01T00:00:00Z",
        },
      } as RunState),
    );
    expect(events[0]).toMatchObject({ state: "failed", errorCategory: "provider-credit" });
    // The raw reason never reaches the page.
    expect(renderActivity({ discoveryLimited: false, events })).not.toContain("credit-exhausted");
  });

  it("reports unavailable and not-configured as unknown rather than stopped", async () => {
    for (const run of [{ state: "unavailable" }, { state: "not-configured" }] as RunState[]) {
      const { events } = await collectActivity(input(run));
      expect(events[0]).toMatchObject({ state: "unknown" });
    }
    const { events: thrown } = await collectActivity(input(new Error("boom")));
    expect(thrown[0]).toMatchObject({ state: "unknown" });
  });

  it("maps workflow progress names to dashboard stages", async () => {
    const { events } = await collectActivity(
      input({
        state: "running",
        progress: { stage: "verify", status: "running", at: "2026-02-01T00:00:00Z" },
      }),
    );
    expect(events[0]).toMatchObject({ component: "verification", state: "started" });
  });

  it("shows a recovery run alongside the original failure", async () => {
    const { events } = await collectActivity(
      input({
        state: "finished",
        result: {
          outcome: "failed",
          reason: "credit-exhausted",
          completedAt: "2026-02-01T00:00:00Z",
        },
        recovery: {
          state: "finished",
          result: { outcome: "verified", completedAt: "2026-02-02T00:00:00Z" },
        },
      } as RunState),
    );
    expect(events).toHaveLength(2);
    // Newest observation first: the recovery follows the failure.
    expect(events[0]).toMatchObject({ state: "completed" });
    expect(events[1]).toMatchObject({ state: "failed", errorCategory: "provider-credit" });
  });

  it("emits nothing for a run that never started", async () => {
    expect((await collectActivity(input({ state: "not-started" }))).events).toEqual([]);
  });

  it("discovers a run on an older post through the run index", async () => {
    const older = {
      publicationId: "pub",
      postId: "old",
      sourceVersion: `sha256:${"b".repeat(64)}`,
    };
    const { events, discoveryLimited } = await collectActivity({
      articles: { recent: async () => [article] },
      runs: {
        status: async (t) =>
          t.postId === "old"
            ? {
                state: "running",
                progress: { stage: "research", status: "running", at: "2026-03-01T00:00:00Z" },
              }
            : { state: "not-started" },
      },
      runIndex: { recent: async () => [older] },
    });
    expect(discoveryLimited).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ postId: "old", component: "research", state: "started" });
  });

  it("states the limitation when no run index is configured", async () => {
    const feed = await collectActivity(input({ state: "not-started" }));
    expect(feed.discoveryLimited).toBe(true);
    expect(renderActivity(feed)).toContain("most recent source posts only");
  });

  it("escapes correlation text and offers an inspect link", async () => {
    const html = renderActivity({
      discoveryLimited: false,
      events: [
        {
          kind: "article-stage",
          component: "<script>",
          publicationId: "pub",
          postId: "p1",
          state: "started",
          link: "/articles/trace?publication=pub&post=p1",
        },
      ],
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("inspect");
  });
});

describe("credit notice on activity, not the article list (#511)", () => {
  it("lists credit-stopped runs with time and link on the activity page", () => {
    const html = renderActivity({
      discoveryLimited: false,
      events: [
        {
          kind: "article-stage",
          component: "article-run",
          publicationId: "pub",
          postId: "p1",
          state: "failed",
          errorCategory: "provider-credit",
          at: "2026-02-01T00:00:00Z",
          link: "/articles/trace?publication=pub&post=p1",
        },
      ],
    });
    expect(html).toContain("Provider credit exhausted");
    expect(html).toContain("2026-02-01T00:00:00Z");
    expect(html).toContain("/articles/trace?publication=pub&amp;post=p1");
  });

  it("shows no credit notice when no run was credit-stopped", () => {
    const html = renderActivity({ discoveryLimited: false, events: [] });
    expect(html).not.toContain("Provider credit exhausted");
  });
});

describe("live runs on any post (#479)", () => {
  const v = (c: string) => `sha256:${c.repeat(64)}`;
  // Newest articles are p1..p3; the owner starts a run on an older post, old1.
  const newest = ["p1", "p2", "p3"].map((postId, i) => ({
    publicationId: "pub",
    postId,
    sourceVersion: v(String(i + 1)),
  }));
  const old = { publicationId: "pub", postId: "old1", sourceVersion: v("e") };
  const articles = {
    recent: async (limit: number) => newest.slice(0, limit),
    find: async (_p: string, postId: string) =>
      [...newest, old].find((a) => a.postId === postId) as never,
  };
  const runs = {
    status: async (t: { postId: string }): Promise<RunState> =>
      t.postId === "old1"
        ? { state: "running" } // just started: no progress timestamp yet
        : ({
            state: "finished",
            result: { outcome: "failed", reason: "x", research: [] } as never,
            completedAt: "2026-11-22T10:00:00.000Z",
          } as RunState),
  };

  it("shows a just-started run on an older post first, from the Restate run index", async () => {
    const { restateRunIndex } = await import("../../src/dashboard/restate-links.js");
    const queries: string[] = [];
    const index = restateRunIndex("http://restate-admin.invalid", articles, {
      fetch: (async (_url: unknown, init?: RequestInit) => {
        queries.push(String(init?.body));
        return new Response(
          JSON.stringify({
            rows: [
              { key: `pub/old1@${"e".repeat(32)}~run-0123456789abcdef` },
              { key: `pub/old1@${"e".repeat(32)}` },
              { key: `pub/gone@${"f".repeat(32)}` }, // not indexed: skipped, never guessed
              { key: "not a key" },
            ],
          }),
        );
      }) as typeof fetch,
    });
    expect(await index.recent(5)).toEqual([old]);
    expect(queries[0]).toContain("ArticleRun");
    const feed = await collectActivity({ articles, runs, runIndex: index, limit: 3 });
    expect(feed.discoveryLimited).toBe(false);
    // The running run is listed first even without a timestamp, and is not cut off.
    expect(feed.events[0]).toMatchObject({ postId: "old1", state: "started" });
  });

  it("without the index, an older post's run is not discovered and the page says so", async () => {
    const feed = await collectActivity({ articles, runs, limit: 3 });
    expect(feed.events.some((e) => e.postId === "old1")).toBe(false);
    expect(feed.discoveryLimited).toBe(true);
  });

  it("an unreachable admin API yields an empty index, not an error", async () => {
    const { restateRunIndex } = await import("../../src/dashboard/restate-links.js");
    const index = restateRunIndex("http://restate-admin.invalid", articles, {
      fetch: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    expect(await index.recent(5)).toEqual([]);
  });
});

describe("activity page refresh (#479)", () => {
  it("reloads a view with refreshSeconds, and only that view", async () => {
    const { createDashboardServer } = await import("../../src/dashboard/server.js");
    const server = createDashboardServer([
      { path: "/activity", title: "Activity", refreshSeconds: 15, render: () => "<p>a</p>" },
      { path: "/other", title: "Other", render: () => "<p>b</p>" },
    ]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const live = await (await fetch(`http://127.0.0.1:${port}/activity`)).text();
      expect(live).toContain('<meta http-equiv="refresh" content="15">');
      const still = await (await fetch(`http://127.0.0.1:${port}/other`)).text();
      expect(still).not.toContain("http-equiv");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
