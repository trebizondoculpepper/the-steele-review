import { describe, expect, it } from "vite-plus/test";
import { articleViews, renderTrace } from "../../src/dashboard/article-views.js";
import {
  sanitizeReason,
  UNRECOGNISED_REASON,
  STALL_MS,
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

  it("separates editorial outcomes from workflow termination (#486)", () => {
    const rejected = summariseRun({
      state: "finished",
      result: { ...verified, outcome: "rejected" as const, approvalEvent: undefined },
    });
    expect(rejected).toMatchObject({ summary: "completed", editorial: "rejected" });
    expect(rejected.stages.at(-1)).toMatchObject({ stage: "delivery", state: "not-reached" });

    const gap = summariseRun({
      state: "finished",
      result: { ...verified, outcome: "evidence-gap" as const },
    });
    expect(gap).toMatchObject({ summary: "completed", editorial: "evidence-gap" });

    const unverified = summariseRun({
      state: "finished",
      result: { ...verified, outcome: "drafted-unverified" as const, verification: undefined },
    });
    expect(unverified).toMatchObject({ summary: "completed", editorial: "unverified" });

    expect(summariseRun({ state: "finished", result: verified })).toMatchObject({
      summary: "completed",
      editorial: "verified",
    });
    expect(summariseRun({ state: "finished", result: claimFailure })).toMatchObject({
      summary: "failed",
      editorial: "none",
    });
    expect(summariseRun({ state: "running" }).editorial).toBe("none");
  });

  it("does not claim dispatch approval when none was recorded (#486)", () => {
    const without = summariseRun({
      state: "finished",
      result: { ...verified, approvalEvent: undefined },
    });
    expect(without.approvalRecorded).toBe(false);
    const htmlWithout = renderTrace({
      post,
      correlationId: "cid",
      editorial: without.editorial,
      ...without,
      receipts: [],
      receiptsTruncated: false,
      source: { state: "not-configured" },
    });
    expect(htmlWithout).toContain("no dispatch approval recorded");
    expect(htmlWithout).not.toContain("approval recorded for dispatch");

    const withApproval = summariseRun({ state: "finished", result: verified });
    expect(withApproval.approvalRecorded).toBe(true);
    const htmlWith = renderTrace({
      post,
      correlationId: "cid",
      editorial: withApproval.editorial,
      ...withApproval,
      receipts: [],
      receiptsTruncated: false,
      source: { state: "not-configured" },
    });
    expect(htmlWith).toContain("approval recorded for dispatch");
  });

  it("renders a rejected draft as unsuccessful without delivery (#486)", () => {
    const summary = summariseRun({
      state: "finished",
      result: { ...verified, outcome: "rejected" as const, approvalEvent: undefined },
    });
    const html = renderTrace({
      post,
      correlationId: "cid",
      editorial: summary.editorial,
      ...summary,
      receipts: [],
      receiptsTruncated: false,
      source: { state: "not-configured" },
    });
    expect(html).toContain("verification rejected");
    expect(html).toContain("this draft was not approved");
    expect(html).not.toContain("approval recorded for dispatch");
    expect(html).not.toContain("delivered");

    const gap = summariseRun({
      state: "finished",
      result: { ...verified, outcome: "evidence-gap" as const },
    });
    const gapHtml = renderTrace({
      post,
      correlationId: "cid",
      editorial: gap.editorial,
      ...gap,
      receipts: [],
      receiptsTruncated: false,
      source: { state: "not-configured" },
    });
    expect(gapHtml).toContain("evidence gap");
    expect(gapHtml).toContain("drafting was not reached");
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

describe("in-progress stage state (#439)", () => {
  const at = "2026-11-21T10:00:00.000Z";
  const now = Date.parse(at) + 60_000;
  it("shows the running stage, with earlier stages done", () => {
    const s = summariseRun(
      { state: "running", progress: { stage: "draft", status: "running", at } },
      now,
    );
    expect(s.summary).toBe("pending");
    expect(s.lastUpdate).toBe(at);
    expect(s.stages.map((x) => `${x.stage}:${x.state}`)).toEqual([
      "capture:done",
      "themes:done",
      "claims:done",
      "research:done",
      "drafting:pending",
      "verification:not-reached",
      "delivery:not-reached",
    ]);
    expect(s.stages[4]!.detail).toContain("draft in progress");
  });

  it("moves to the next stage once one completes, and marks stalled progress explicitly", () => {
    const done = summariseRun(
      { state: "running", progress: { stage: "claims", status: "completed", at } },
      now,
    );
    expect(done.stages[3]).toMatchObject({ stage: "research", state: "pending" });
    const stalled = summariseRun(
      { state: "running", progress: { stage: "claims", status: "running", at } },
      Date.parse(at) + STALL_MS + 1,
    );
    expect(stalled.stages[2]!.detail).toMatch(/^stalled: no update since/);
  });

  it("keeps a grouped stage pending until its last step completes", () => {
    const state = (stage: string, status: "running" | "completed") =>
      summariseRun({ state: "running", progress: { stage, status, at } }, now).stages.map(
        (x) => `${x.stage}:${x.state}`,
      );
    // plan-research, research and coverage are all "research".
    expect(state("plan-research", "completed")).toContain("research:pending");
    expect(state("research", "completed")).toContain("research:pending");
    expect(state("coverage", "completed")).toContain("drafting:pending");
    // package and draft are both "drafting".
    expect(state("package", "completed")).toContain("drafting:pending");
    expect(state("package", "completed")).toContain("verification:not-reached");
    expect(state("draft", "completed")).toContain("verification:pending");
  });

  it("never treats missing progress as success", () => {
    expect(summariseRun({ state: "running", progress: null }).stages[1]).toMatchObject({
      state: "pending",
      detail: "starting",
    });
    expect(summariseRun({ state: "running" }).stages[1]).toMatchObject({
      state: "pending",
      detail: "progress unavailable",
    });
  });
});

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
      receiptsTruncated: false,
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
    // Article markup is still escaped and never executed, without showing
    // implementation language in the reader.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("markup is never executed");
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
      receiptsTruncated: false,
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
          return { receipts: [], truncated: false };
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
          return { receipts: [], truncated: false };
        },
      },
    });
    expect(t.receipts).toEqual([]);
    expect(asked).toBe(0);
  });

  it("links list actions to confirmation for the exact archived revision", async () => {
    const [list] = articleViews({ articles, canTrigger: true });
    const html = await list!.render(new URL("http://x/articles"));
    expect(html).toContain("<th>Action</th>");
    expect(html).toContain(
      `href="/articles/run?publication=pub&amp;post=p1&amp;revision=${encodeURIComponent(V)}"`,
    );
    expect(html).toContain("Run this revision</a>");
    expect(html).not.toContain("<form");
    const [readOnly] = articleViews({ articles });
    expect(await readOnly!.render(new URL("http://x/articles"))).not.toContain("/articles/run");
  });

  it("uses the configured canonical origin instead of a request alias", async () => {
    const [list] = articleViews({
      articles,
      canTrigger: true,
      actionOrigin: "https://console.example.test",
    });
    const html = await list!.render(new URL("http://alias.example.test/articles"));
    expect(html).toContain('href="https://console.example.test/articles/run?');
    expect(html).not.toContain('href="http://alias.example.test/articles/run?');
  });

  it("does not offer an action for an unknown indexed revision", async () => {
    const [list] = articleViews({
      articles: { ...articles, recent: async () => [{ ...post, sourceVersion: "unknown" }] },
      canTrigger: true,
    });
    const html = await list!.render(new URL("http://x/articles"));
    expect(html).toContain("Revision unavailable");
    expect(html).not.toContain("/articles/run");
  });

  it("lists recent articles with run state, escaping titles", async () => {
    const [list] = articleViews({ articles, runs: runs({ p1: { state: "running" } }) });
    const html = await list!.render(new URL("http://x/articles"));
    expect(html).toContain("&lt;b&gt;Weather&lt;/b&gt; &amp; war");
    expect(html).toContain('href="/articles/trace?publication=pub&amp;post=p1"');
    expect(html).toContain('<span class="s-pending">pending</span>');
    expect(html).toContain('<span class="s-not-started">not-started</span>');
  });

  it("lists a rejected article as unsuccessful, not completed (#486)", async () => {
    const [list] = articleViews({
      articles,
      runs: runs({
        p1: {
          state: "finished",
          result: { ...verified, outcome: "rejected" as const, approvalEvent: undefined },
        },
      }),
    });
    const html = await list!.render(new URL("http://x/articles"));
    expect(html).toContain('<span class="s-rejected">rejected</span>');
    expect(html).not.toContain('<span class="s-completed">completed</span>');
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

describe("editorial timeline (#644)", { timeout: 60_000 }, () => {
  const assessment = (over: Record<string, unknown> = {}) => ({
    path: `assessments/pub/p1/${"1".repeat(32)}.json`,
    publicationId: "pub",
    postId: "p1",
    state: "findings" as const,
    findings: 1,
    deterministicFindings: 0,
    assessorModel: "fake/assessor",
    promptVersion: "assessor-prompt",
    assessedAt: "2026-01-01T00:00:00Z",
    hasDocument: true,
    ...over,
  });
  const judgment = (over: Record<string, unknown> = {}) => ({
    path: `judgments/pub/p1/${"2".repeat(32)}.json`,
    publicationId: "pub",
    postId: "p1",
    state: "decided" as const,
    decision: "revise" as const,
    gateCount: 0,
    judgeModel: "fake/judge",
    promptVersion: "judge-prompt",
    decidedAt: "2026-01-01T01:00:00Z",
    hasDocument: true,
    ...over,
  });

  it("shows every assessor and judge pass chronologically with exact links", async () => {
    const [, detail] = articleViews({
      articles: {
        recent: async () => [],
        find: async () => ({ ...post, sourceVersion: `sha256:${"a".repeat(64)}` }),
      },
      assessments: {
        list: async () => ({
          state: "ok",
          rows: [
            assessment(),
            assessment({
              path: `assessments/pub/p1/${"3".repeat(32)}.json`,
              state: "provider-failed",
              findings: undefined,
              assessedAt: "2026-01-02T02:00:00Z",
            }),
          ],
          partial: false,
          unreadable: 0,
        }),
        detail: async () => undefined,
      },
      judgments: {
        list: async () => ({
          state: "ok",
          rows: [
            judgment(),
            judgment({
              path: `judgments/pub/p1/${"4".repeat(32)}.json`,
              decision: "approve",
              decidedAt: "2026-01-02T03:00:00Z",
            }),
          ],
          partial: false,
          unreadable: 0,
        }),
        detail: async () => undefined,
      },
    });
    const html = await detail!.render(
      new URL("http://x/articles/trace?publication=pub&post=p1"),
    );
    expect(html).toContain("Editorial timeline");
    // Ordering: assessment, judgment, failed assessment, approval judgment.
    const revise = html.indexOf("judgment: decided / revise");
    const failed = html.indexOf("assessment: provider-failed");
    const approve = html.indexOf("judgment: decided / approve");
    expect(revise).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(revise);
    expect(approve).toBeGreaterThan(failed);
    expect(html).toContain("requested an editorial revision");
    expect(html).toContain(`/assessments/view?path=${encodeURIComponent(`assessments/pub/p1/${"3".repeat(32)}.json`)}`);
    expect(html).toContain(`/judgments/view?path=${encodeURIComponent(`judgments/pub/p1/${"4".repeat(32)}.json`)}`);
    expect(html).toContain("Mechanical writer repair turns are not editorial revisions");
    expect(html).toContain("/assessments?post=pub%2Fp1");
    expect(html).toContain("/judgments?post=pub%2Fp1");
  });

  it("labels missing passes as not approval and reports bounded history", async () => {
    const [, detail] = articleViews({
      articles: {
        recent: async () => [],
        find: async () => ({ ...post, sourceVersion: `sha256:${"a".repeat(64)}` }),
      },
      assessments: {
        list: async () => ({ state: "ok", rows: [], partial: true, unreadable: 1, next: "x" }),
        detail: async () => undefined,
      },
      judgments: {
        list: async () => ({ state: "unavailable", rows: [], partial: false, unreadable: 0 }),
        detail: async () => undefined,
      },
    });
    const html = await detail!.render(
      new URL("http://x/articles/trace?publication=pub&post=p1"),
    );
    expect(html).toContain("Judge attempts are unavailable");
    expect(html).toContain("bounded");
    expect(html).toContain("could not be read");
    expect(html).toContain("not approval");
  });

  it("keeps incomplete-history warnings when the scan finds no rows", async () => {
    const [, detail] = articleViews({
      articles: {
        recent: async () => [],
        find: async () => ({ ...post, sourceVersion: `sha256:${"a".repeat(64)}` }),
      },
      assessments: {
        list: async () => ({ state: "ok", rows: [], partial: true, unreadable: 0, next: "x" }),
        detail: async () => undefined,
      },
      judgments: {
        list: async () => ({ state: "ok", rows: [], partial: false, unreadable: 2 }),
        detail: async () => undefined,
      },
    });
    const html = await detail!.render(
      new URL("http://x/articles/trace?publication=pub&post=p1"),
    );
    expect(html).not.toContain("No assessor or judge attempts are saved");
    expect(html).toContain("bounded");
    expect(html).toContain("could not be read");
    expect(html).toContain("/assessments?post=pub%2Fp1");
    expect(html).toContain("/judgments?post=pub%2Fp1");
  });

  it("shows an explicit empty state when no editorial records exist", async () => {
    const [, detail] = articleViews({
      articles: {
        recent: async () => [],
        find: async () => ({ ...post, sourceVersion: `sha256:${"a".repeat(64)}` }),
      },
      assessments: {
        list: async () => ({ state: "ok", rows: [], partial: false, unreadable: 0 }),
        detail: async () => undefined,
      },
      judgments: {
        list: async () => ({ state: "ok", rows: [], partial: false, unreadable: 0 }),
        detail: async () => undefined,
      },
    });
    const html = await detail!.render(
      new URL("http://x/articles/trace?publication=pub&post=p1"),
    );
    expect(html).toContain("No assessor or judge attempts are saved");
    expect(html).toContain("not approval");
  });
});
