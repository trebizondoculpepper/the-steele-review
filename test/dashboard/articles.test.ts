import { describe, expect, it } from "vite-plus/test";
import { articleViews, renderTrace } from "../../src/dashboard/article-views.js";
import {
  sanitizeReason,
  UNRECOGNISED_REASON,
  summariseRun,
  traceArticle,
  type RecentArticlesPort,
  type RunState,
  type RunStatusPort,
} from "../../src/dashboard/articles.js";
import { postCorrelationId } from "../../src/observability/post-correlation.js";
import type { ArticleRunFinal } from "../../src/workflow/article-run.js";

const ref = {
  repository: "content",
  commit: "a".repeat(40),
  path: "x.json",
  sha256: "b".repeat(64),
};
const V = `sha256:${"1".repeat(64)}`;
const verified: ArticleRunFinal = {
  outcome: "verified",
  themes: ref,
  claims: ref,
  coverage: ref,
  package: ref,
  draft: ref,
  verification: ref,
  research: [{ jobId: "job-1", outcome: "finished" }],
  approvalEvent: "evt-1",
};
// As #244's run ended: a terminal claim-extraction stage failure.
const claimFailure: ArticleRunFinal = {
  outcome: "failed",
  reason: "claims: provider-failed",
  research: [],
};

const states = (run: RunState) => summariseRun(run).stages.map((s) => `${s.stage}:${s.state}`);

describe("article run summaries (#377)", () => {
  it("shows a completed fixture through delivery", () => {
    const s = summariseRun({ state: "finished", result: verified });
    expect(s.summary).toBe("completed");
    expect(states({ state: "finished", result: verified })).toEqual([
      "capture:done",
      "themes:done",
      "claims:done",
      "research:done",
      "drafting:done",
      "verification:done",
      "delivery:done",
    ]);
    expect(s.research).toEqual([{ jobId: "job-1", outcome: "finished" }]);
  });

  it("places a claim-extraction failure at its stage, distinct from pending work", () => {
    const failed = summariseRun({ state: "finished", result: claimFailure });
    expect(failed).toMatchObject({ summary: "failed", reason: "claims: provider-failed" });
    expect(states({ state: "finished", result: claimFailure })).toEqual([
      "capture:done",
      "themes:done",
      "claims:failed",
      "research:not-reached",
      "drafting:not-reached",
      "verification:not-reached",
      "delivery:not-reached",
    ]);
    expect(summariseRun({ state: "running" }).summary).toBe("pending");
    expect(states({ state: "running" })[1]).toBe("themes:pending");
    expect(summariseRun({ state: "not-started" }).summary).toBe("not-started");
    expect(summariseRun({ state: "unavailable" }).summary).toBe("unknown");
  });

  it("shows a rejected draft as not delivered", () => {
    const rejected = { ...verified, outcome: "rejected" as const, approvalEvent: undefined };
    const s = summariseRun({ state: "finished", result: rejected });
    expect(s.stages.at(-2)).toMatchObject({ stage: "verification", state: "failed" });
    expect(s.stages.at(-1)).toMatchObject({ stage: "delivery", state: "not-reached" });
  });

  it("reduces failure reasons to allowlisted categories", () => {
    expect(sanitizeReason("claims: provider-failed")).toBe("claims: provider-failed");
    expect(sanitizeReason("unresolved after 2 redrafts")).toBe("unresolved after 2 redrafts");
    expect(sanitizeReason("no verifier model configured")).toBe("no verifier model configured");
    for (const leaky of [
      "draft: fetch https://secret.example/x failed",
      "connect ECONNREFUSED 192.168.1.5:9200",
      "verify: ENOENT /home/alice/private/state.db",
      "token=abc123 rejected",
      "nas.local unreachable",
    ]) {
      expect(sanitizeReason(leaky)).toBe(UNRECOGNISED_REASON);
    }
  });
});

const post = { publicationId: "pub", postId: "p1" };
const articles: RecentArticlesPort = {
  recent: async () => [
    {
      ...post,
      title: "<b>Weather</b> & war",
      publishedAt: "2026-11-01T00:00:00Z",
      sourceVersion: V,
    },
    { publicationId: "pub", postId: "p2", sourceVersion: V },
  ],
  find: async (publicationId, postId) => ({ publicationId, postId, sourceVersion: V }),
};
const runs = (by: Record<string, RunState>): RunStatusPort & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    status: async (p) => {
      asked.push(`${p.postId}@${p.sourceVersion}`);
      return by[p.postId] ?? { state: "not-started" };
    },
  };
};

describe("article pages (#377)", () => {
  it("traces the exact revision with the logs' correlation ID", async () => {
    const r = runs({ p1: { state: "finished", result: claimFailure } });
    const t = await traceArticle({ post, articles, runs: r });
    expect(t.correlationId).toBe(postCorrelationId(post));
    expect(r.asked).toEqual([`p1@${V}`]);
    const html = renderTrace(t);
    expect(html).toContain(postCorrelationId(post));
    expect(html).toContain('<span class="s-failed">failed</span>');
  });

  it("renders the saved draft safely with its verification and receipts", async () => {
    const t = {
      post,
      correlationId: "cid",
      summary: "completed" as const,
      stages: [],
      research: [],
      draft: { hash: "c".repeat(64), text: "<script>alert('x')</script> A claim." },
      verification: {
        outcome: "redraft",
        matchesDraft: false,
        draftHash: `sha256:${"d".repeat(64)}`,
      },
      receipts: [
        {
          destination: "dummy-a",
          action: "draft",
          simulated: true,
          deliveredAt: "2026-01-01T00:00:00Z",
        },
        {
          destination: "real",
          action: "publish",
          simulated: false,
          deliveredAt: "2026-01-01T00:00:00Z",
          url: "https://example.test/post",
        },
      ],
    };
    const html = renderTrace(t);
    // Article markup is shown as text, never executed.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    // A report for another revision is called out, not presented as approval.
    expect(html).toContain("does not bind to the saved draft");
    expect(html).toContain("redraft");
    // Simulated deliveries are labelled; only the real receipt carries a link.
    expect(html).toContain("simulated");
    expect(html).toContain('href="https://example.test/post"');
    expect(html).toContain("delivered");
    expect(html).not.toContain(">published<");
  });

  it("confirms a verification that binds to the exact draft", () => {
    const html = renderTrace({
      post,
      correlationId: "cid",
      summary: "completed",
      stages: [],
      research: [],
      draft: { hash: "c".repeat(64), text: "body" },
      verification: { outcome: "approved", matchesDraft: true },
      receipts: [],
    });
    expect(html).toContain("binds to the exact saved draft");
    expect(html).toContain("approved");
  });

  it("binds receipts to the run's draft even when its text is unreadable", async () => {
    const asked: Array<string | undefined> = [];
    const t = await traceArticle({
      post,
      articles,
      runs: runs({ p1: { state: "finished", result: verified } }),
      content: {
        draft: async () => undefined,
        verification: async () => undefined,
      },
      receipts: {
        receiptsFor: async (_post, hash) => {
          asked.push(hash);
          return [];
        },
      },
    });
    expect(asked).toEqual([`sha256:${"b".repeat(64)}`]);
    expect(t.draft).toBeUndefined();
  });

  it("shows no receipts when the run produced no draft", async () => {
    let asked = 0;
    const t = await traceArticle({
      post,
      articles,
      runs: runs({ p1: { state: "finished", result: claimFailure } }),
      receipts: {
        receiptsFor: async () => {
          asked++;
          return [];
        },
      },
    });
    expect(t.receipts).toEqual([]);
    expect(asked).toBe(0);
  });

  it("lists recent articles with run state, escaping titles", async () => {
    const [list] = articleViews({ articles, runs: runs({ p1: { state: "running" } }) });
    const html = await list!.render(new URL("http://x/articles"));
    expect(html).toContain("&lt;b&gt;Weather&lt;/b&gt; &amp; war");
    expect(html).toContain('href="/articles/trace?publication=pub&amp;post=p1"');
    expect(html).toContain('<span class="s-pending">pending</span>');
    expect(html).toContain('<span class="s-not-started">not-started</span>');
  });

  it("rejects malformed identifiers and reports missing sources", async () => {
    const [list, detail] = articleViews({});
    expect(await list!.render(new URL("http://x/articles"))).toContain("not configured");
    expect(
      await detail!.render(new URL("http://x/articles/trace?publication=../x&post=p1")),
    ).toContain("Choose an article");
    const t = await traceArticle({ post });
    expect(t.summary).toBe("unknown");
  });
});
