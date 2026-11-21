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
      input({ state: "running", progress: { stage: "drafting", status: "running", at: "2026-02-01T00:00:00Z" } }),
    );
    expect(events[0]).toMatchObject({ component: "drafting", state: "started", at: "2026-02-01T00:00:00Z" });
  });

  it("shows a failed run with a sanitised error category", async () => {
    const { events } = await collectActivity(
      input({ state: "finished", result: { outcome: "failed", reason: "credit-exhausted", at: "2026-02-01T00:00:00Z" } } as RunState),
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
      input({ state: "running", progress: { stage: "verify", status: "running", at: "2026-02-01T00:00:00Z" } }),
    );
    expect(events[0]).toMatchObject({ component: "verification", state: "started" });
  });

  it("shows a recovery run alongside the original failure", async () => {
    const { events } = await collectActivity(
      input({
        state: "finished",
        result: { outcome: "failed", reason: "credit-exhausted", at: "2026-02-01T00:00:00Z" },
        recovery: { state: "finished", result: { outcome: "verified", at: "2026-02-02T00:00:00Z" } },
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
    const older = { publicationId: "pub", postId: "old", sourceVersion: `sha256:${"b".repeat(64)}` };
    const { events, discoveryLimited } = await collectActivity({
      articles: { recent: async () => [article] },
      runs: {
        status: async (t) =>
          t.postId === "old"
            ? { state: "running", progress: { stage: "research", status: "running", at: "2026-03-01T00:00:00Z" } }
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
    const html = renderActivity({ discoveryLimited: false, events: [
      { kind: "article-stage", component: "<script>", publicationId: "pub", postId: "p1", state: "started", link: "/articles/trace?publication=pub&post=p1" },
    ] });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("inspect");
  });
});
