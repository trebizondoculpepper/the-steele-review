import { createHash } from "node:crypto";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import type { ResearchRequest } from "../../src/research/job.js";
import { researchJobId } from "../../src/research/job.js";
import {
  RESEARCH_CONCURRENCY_RULE,
  StageError,
  articleRunKey,
  articleRunTarget,
  articleRunWorkflow,
  researchService,
  type ArticleRunInput,
  type ArticleStages,
  type PinnedResearch,
  type Ref,
} from "../../src/workflow/article-run.js";
import {
  createCapturedContentEvent,
  type CapturedContentData,
} from "../../src/events/captured-content-event.js";
import { articleRunInputFor, handleCapturedContent } from "../../src/workflow/captured-bridge.js";

/**
 * Deterministic integration test against a real Restate 1.8.1 container with
 * controlled stages: full, partial and slow research; the batch deadline; late
 * results; duplicate triggers; and the shared research concurrency cap.
 * Requires Docker.
 */

const ref = (path: string): Ref => ({
  repository: "content",
  commit: "a".repeat(40),
  path,
  sha256: "b".repeat(64),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const request = (subject: string): ResearchRequest => ({
  schemaVersion: 1,
  origin: "manual",
  subject,
  pass: 1,
  claims: [],
  corpusRefs: [],
});

/** Delay per research subject, in ms: "slow-*" outlives every deadline. */
const delayFor = (subject: string) =>
  subject.startsWith("slow") ? 20_000 : subject.startsWith("partial") ? 1_500 : 500;

const calls = {
  themes: 0,
  claims: 0,
  plan: 0,
  coverage: 0,
  draft: 0,
  verify: 0,
  research: 0,
  approve: 0,
};
let active = 0;
let maxActive = 0;
const pinnedByPost = new Map<string, PinnedResearch[]>();
const plans = new Map<string, string[]>();
const researchSubjects: string[] = [];

const stages: ArticleStages = {
  themes: async (post) => {
    calls.themes++;
    if (post.postId === "incomplete") throw new StageError("source", "incomplete-capture");
    return ref(`theme-proposals/${post.postId}.json`);
  },
  claims: async (post) => {
    calls.claims++;
    // Synthetic provider credit exhaustion (#407): no paid request.
    if (post.postId === "no-credit") throw new ModelProviderError("credit-exhausted", 402);
    if (post.postId === "slow-claims") await sleep(2_500); // observable in-progress stage (#439)
    return ref(`claim-extractions/${post.postId}.json`);
  },
  planResearch: async (themes) => {
    calls.plan++;
    const post = themes.path.split("/")[1].replace(".json", "");
    return (plans.get(post) ?? []).map(request);
  },
  research: async (req) => {
    calls.research++;
    researchSubjects.push(req.subject!);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await sleep(delayFor(req.subject!));
      const jobId = researchJobId(req);
      const partial = req.subject!.startsWith("partial");
      return {
        jobId,
        status: "finished",
        result: {
          schemaVersion: 1,
          jobId,
          outcome: partial ? "complete-with-gaps" : "complete",
          manifest: {
            repository: "content",
            commit: "c".repeat(40),
            path: `research-jobs/${jobId}/manifest.json`,
            hash: `sha256:${"d".repeat(64)}`,
          },
          finishedAt: "2026-01-01T00:00:00Z",
        },
      };
    } finally {
      active--;
    }
  },
  coverage: async (themes, _claims, pinned) => {
    calls.coverage++;
    pinnedByPost.set(themes.path, pinned);
    return ref(`librarian/coverage/${themes.path}`);
  },
  package: async (coverage) => ({ ref: ref(`writer-packages/${coverage.path}`), status: "ready" }),
  draft: async (pkg) => (calls.draft++, { ref: ref(`articles/${pkg.path}.md`) }),
  verify: async (draft) => (
    calls.verify++,
    { ref: ref(`verifications/${draft.path}.json`), approved: !draft.path.includes("rejected") }
  ),
  approve: async (report) => (calls.approve++, { eventId: `approved-${report.path}` }),
};

let env: RestateTestEnvironment;
let ingress: clients.Ingress;
const Workflow = articleRunWorkflow(stages);
beforeAll(async () => {
  env = await RestateTestEnvironment.start(
    { services: [Workflow, researchService(stages)] },
    () => new RestateContainer("1.8.1"),
  );
  const put = await fetch(`${env.adminAPIBaseUrl()}/limits/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(RESEARCH_CONCURRENCY_RULE),
  });
  expect(put.ok).toBe(true);
  ingress = clients.connect({ url: env.baseUrl() });
}, 240_000);
afterAll(async () => {
  await env?.stop();
});

const input = (postId: string): ArticleRunInput => ({
  publicationId: "pub",
  postId,
  sourceVersion: `sha256:${createHash("sha256").update(postId).digest("hex")}`,
  sourceUrl: `https://pub.example.com/p/${postId}`,
  researchDeadlineMs: 6_000,
});

describe("unattended article run on Restate (#243)", () => {
  it("pins full and partial research at the deadline, records the slow job as a gap, and drafts once", async () => {
    plans.set("one", ["full-a", "partial-b", "slow-c"]);
    const key = articleRunKey(input("one"));
    const wf = ingress.workflowClient(Workflow, key);
    await wf.workflowSubmit(input("one"));
    // A redelivered trigger for the same revision attaches to the same run.
    await wf.workflowSubmit(input("one")).catch(() => undefined);
    const result = await wf.workflowAttach();
    expect(result.outcome).toBe("verified");
    expect(result.research.map((r) => r.outcome).sort()).toEqual([
      "finished",
      "finished",
      "timed-out",
    ]);
    const pinned = pinnedByPost.get("theme-proposals/one.json")!;
    expect(pinned.find((p) => p.request.subject === "slow-c")?.outcome).toBe("timed-out");
    expect(pinned.find((p) => p.request.subject === "partial-b")).toMatchObject({
      outcome: "finished",
      job: { result: { outcome: "complete-with-gaps" } },
    });
    expect(calls.draft).toBe(1);
    expect(calls.verify).toBe(1);
  }, 120_000);

  it("never lets a late result change the pinned writer input", async () => {
    const before = calls.coverage;
    await sleep(15_000); // the slow job from the first run finishes now
    expect(calls.coverage).toBe(before);
    expect(
      pinnedByPost.get("theme-proposals/one.json")!.find((p) => p.request.subject === "slow-c")
        ?.outcome,
    ).toBe("timed-out");
  }, 60_000);

  it("caps active research at two across concurrent runs, and queued jobs never hold up drafting", async () => {
    maxActive = 0;
    plans.set("two", ["full-d", "full-e", "partial-f", "slow-g"]);
    plans.set("three", ["full-h", "partial-i", "slow-j", "slow-k"]);
    const two = ingress.workflowClient(Workflow, articleRunKey(input("two")));
    const three = ingress.workflowClient(Workflow, articleRunKey(input("three")));
    await Promise.all([two.workflowSubmit(input("two")), three.workflowSubmit(input("three"))]);
    const [a, b] = await Promise.all([two.workflowAttach(), three.workflowAttach()]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(a.outcome).toBe("verified");
    expect(b.outcome).toBe("verified");
    // Jobs still queued or running at the cutoff are gaps, not blockers.
    expect([...a.research, ...b.research].some((r) => r.outcome === "timed-out")).toBe(true);
  }, 180_000);

  it("ends a run with a recorded reason on a permanent stage failure or invalid input, without retrying", async () => {
    const before = calls.themes;
    const bad = ingress.workflowClient(Workflow, articleRunKey(input("incomplete")));
    await bad.workflowSubmit(input("incomplete"));
    expect(await bad.workflowAttach()).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("incomplete-capture"),
    });
    expect(calls.themes).toBe(before + 1);
    const invalid = ingress.workflowClient(Workflow, "pub/invalid@x");
    await invalid.workflowSubmit({ ...input("invalid"), researchDeadlineMs: -1 });
    expect(await invalid.workflowAttach()).toMatchObject({
      outcome: "failed",
      reason: "invalid-input",
    });
  }, 60_000);

  it("records durable progress that advances in order and never regresses (#439)", async () => {
    const run = ingress.workflowClient(Workflow, articleRunKey(input("slow-claims")));
    await run.workflowSubmit(input("slow-claims"));
    const seen: string[] = [];
    let indexes: number[] = [];
    for (let i = 0; i < 40; i++) {
      const p = await run.progress();
      if (p) {
        seen.push(`${p.stage}:${p.status}`);
        indexes.push(p.index);
      }
      if ((await run.workflowOutput()).ready) break;
      await sleep(150);
    }
    await run.workflowAttach();
    // While claims was slow, it was visible as the running stage after themes completed.
    expect(seen).toContain("claims:running");
    expect(seen.indexOf("claims:running")).toBeGreaterThan(-1);
    // The stage index never moved backwards across polls.
    indexes = indexes.filter((v, i, a) => i === 0 || v !== a[i - 1]);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    const final = await run.progress();
    expect(final?.status).toBe("completed");
  }, 60_000);

  it("ends a run blocked on provider credit with a terminal, non-editorial reason, without retrying", async () => {
    const before = calls.claims;
    const run = ingress.workflowClient(Workflow, articleRunKey(input("no-credit")));
    await run.workflowSubmit(input("no-credit"));
    expect(await run.workflowAttach()).toMatchObject({
      outcome: "failed",
      reason: "claims: credit-exhausted",
    });
    // One call: credit exhaustion is never retried inside the run.
    expect(calls.claims).toBe(before + 1);
  }, 60_000);

  it("hands an approval to publishing once, and a rejected draft emits none", async () => {
    const before = calls.approve;
    const ok = ingress.workflowClient(Workflow, articleRunKey(input("approved-one")));
    await ok.workflowSubmit(input("approved-one"));
    expect(await ok.workflowAttach()).toMatchObject({
      outcome: "verified",
      approvalEvent: expect.stringContaining("approved-one"),
    });
    expect(calls.approve).toBe(before + 1);
    const no = ingress.workflowClient(Workflow, articleRunKey(input("rejected-one")));
    await no.workflowSubmit(input("rejected-one"));
    const rejected = await no.workflowAttach();
    expect(rejected).toMatchObject({ outcome: "rejected" });
    expect(rejected).not.toHaveProperty("approvalEvent");
    expect(calls.approve).toBe(before + 1);
  }, 60_000);

  it("starts one run per live captured revision; redelivery and Substack replay attach to it", async () => {
    const artifact = {
      repository: "archive",
      commit: "e".repeat(40),
      path: "substack/pub/captured/collected.json",
      hash: `sha256:${"f".repeat(64)}`,
    };
    const event = (over: Record<string, unknown> = {}) =>
      JSON.stringify(
        createCapturedContentEvent(
          {
            source: { namespace: "substack/pub", kind: "substack" },
            itemId: "captured",
            originalUrl: "https://pub.example.com/p/captured",
            artifact,
            sourceVersion: input("captured").sourceVersion,
            complete: true,
            transcript: { kind: "none" },
            ingestionReason: "live",
            ...over,
          } as CapturedContentData,
          () => new Date("2026-11-20T00:00:00Z"),
        ).toJSON(),
      );
    const submitted: string[] = [];
    const options = {
      enabledSources: new Set(["substack/pub", "blog/example-site"]),
      researchDeadlineMs: 6_000,
      submit: async (key: string, runInput: ArticleRunInput) => {
        submitted.push(key);
        const s = await ingress.workflowClient(Workflow, key).workflowSubmit(runInput);
        return s.status === "PreviouslyAccepted"
          ? ("already-running" as const)
          : ("started" as const);
      },
    };
    const first = await handleCapturedContent(event(), options);
    expect(first).toMatchObject({ action: "ack", outcome: "started" });
    // Redelivery after a crash before ack: Restate already has the run.
    expect(await handleCapturedContent(event(), options)).toMatchObject({
      action: "ack",
      outcome: "already-running",
    });
    // A Substack replay from the CLI uses the same key.
    expect(first.action === "ack" && "key" in first && first.key).toBe(
      articleRunKey(input("captured")),
    );
    const result = await ingress
      .workflowClient(Workflow, articleRunKey(input("captured")))
      .workflowAttach();
    expect(result).toMatchObject({ outcome: "verified" });

    // Backfill, disabled sources and incomplete captures never start runs.
    for (const [over, reason] of [
      [{ ingestionReason: "backfill" }, "not-live"],
      [{ ingestionReason: "reprocess" }, "not-live"],
      [{ source: { namespace: "substack/other", kind: "substack" } }, "source-disabled"],
      [{ complete: false }, "incomplete"],
    ] as const) {
      expect(await handleCapturedContent(event(over), options)).toMatchObject({
        action: "ack",
        outcome: "skipped",
        reason,
      });
    }
    expect(submitted).toHaveLength(2);
    expect(await handleCapturedContent("{nope", options)).toEqual({
      action: "term",
      reason: "invalid-event",
    });
    // Restate unreachable: not acknowledged, so the event is redelivered.
    expect(
      await handleCapturedContent(event(), {
        ...options,
        submit: async () => {
          throw new Error("down");
        },
      }),
    ).toMatchObject({ action: "nak", reason: "submission-failed" });
  }, 60_000);

  it("runs a non-Substack source under its own identity", async () => {
    const parsed = {
      source: { namespace: "blog/example-site", kind: "blog" },
      itemId: "2026-11-20_a.post",
      originalUrl: "https://example-site.test/a-post",
      artifact: {
        repository: "archive",
        commit: "e".repeat(40),
        path: "blog/example-site/a/collected.json",
        hash: `sha256:${"f".repeat(64)}`,
      },
      sourceVersion: input("blog").sourceVersion,
      complete: true,
      transcript: { kind: "none" as const },
      ingestionReason: "live" as const,
      eventId: "x",
    };
    const runInput = articleRunInputFor(parsed, 6_000);
    // A Substack publication named like the blog cannot share its identity.
    expect(articleRunTarget("substack/blog-example-site", parsed.itemId).publicationId).not.toBe(
      articleRunTarget("blog/example-site", parsed.itemId).publicationId,
    );
    expect(runInput).toMatchObject({
      publicationId: expect.stringMatching(/^blog-example-site-[0-9a-f]{12}$/),
      postId: expect.stringMatching(/^2026-11-20-a-post-[0-9a-f]{12}$/),
    });
    // An encoded ID must never equal an item ID that needed no encoding.
    const encoded = articleRunTarget("blog/example-site", "2026-11-20_a.post");
    const literal = articleRunTarget("blog/example-site", encoded.postId);
    expect(literal.postId).not.toBe(encoded.postId);
    // Substack keeps its raw post ID so a replay shares the key.
    expect(articleRunTarget("substack/pub", "2026-11-20_a.post").postId).toBe("2026-11-20_a.post");
    // A 200-character slug-safe ID stays within the workflow's limit.
    const long = articleRunTarget("blog/example-site", "a".repeat(200));
    expect(long.postId.length).toBeLessThanOrEqual(200);
    const wf = ingress.workflowClient(Workflow, articleRunKey(runInput));
    await wf.workflowSubmit(runInput);
    expect(await wf.workflowAttach()).toMatchObject({ outcome: "verified" });
    // Identity that does not match the captured source is refused.
    const bad = ingress.workflowClient(Workflow, "blog-example-site/mismatch@x");
    await bad.workflowSubmit({ ...runInput, postId: "other" });
    expect(await bad.workflowAttach()).toMatchObject({
      outcome: "failed",
      reason: "invalid-input",
    });
  }, 60_000);

  it("caps the ordered research plan and preserves the cap on duplicate submission", async () => {
    plans.set("capped", ["cap-first", "cap-second", "cap-third"]);
    // Earlier tests can leave slow jobs queued under the shared concurrency rule.
    const post = { ...input("capped"), researchRequestLimit: 2, researchDeadlineMs: 60_000 };
    const client = ingress.workflowClient(Workflow, articleRunKey(post));
    await client.workflowSubmit(post);
    await client.workflowSubmit({ ...post, researchRequestLimit: 3 }).catch(() => undefined);
    const result = await client.workflowAttach();
    expect(result.outcome).toBe("verified");
    expect(result.research.map((item) => item.outcome)).toEqual([
      "finished",
      "finished",
      "not-commissioned",
    ]);
    expect(researchSubjects.filter((subject) => subject.startsWith("cap-")).sort()).toEqual([
      "cap-first",
      "cap-second",
    ]);
  }, 120_000);
});
