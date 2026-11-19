import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { BRIEF_READY_SUBJECT } from "../../src/drafting/brief.js";
import {
  RESEARCH_REQUESTED_SUBJECT,
  ResearchCoordinator,
  researchNeedId,
  type CoordinatorPost,
  type ResearchKeeper,
} from "../../src/drafting/research-coordinator.js";
import type { ApplicabilityResult } from "../../src/research/applicability.js";

const h = (c: string) => `sha256:${c.repeat(64)}`;
const post = (postId: string, statements: string[]): CoordinatorPost => {
  const artifact = {
    repository: "archive",
    commit: "a".repeat(40),
    path: `substack/pub/${postId}/collected.json`,
    hash: h("b"),
  };
  const source = {
    publicationId: "pub",
    postId,
    url: `https://pub.substack.com/p/${postId}`,
    sourceVersion: h(postId === "p1" ? "1" : "2"),
    artifact,
    ingestionReason: "live" as const,
  };
  let at = 0;
  return {
    source,
    claims: statements.map((statement, i) => {
      const span = { start: at, end: at + statement.length };
      at += statement.length + 1;
      return {
        id: h(String(i + 3)),
        statement,
        passage: statement,
        span,
        artifact,
        sourceVersion: source.sourceVersion,
      };
    }),
  };
};
const TOWERS = "The towers emit dangerous radiation.";
const FEES = "The council secretly doubled fees.";

/** Fake research keeper over a mutable corpus of statements it can support. */
function keeper(corpus: Set<string>, fail = false) {
  let calls = 0;
  const k: ResearchKeeper = {
    async assess(claim) {
      calls++;
      if (fail) return { status: "failed", reason: "provider-failed" };
      const covered = corpus.has(claim.statement);
      const result: ApplicabilityResult = {
        status: "complete",
        claimId: claim.id,
        assessments: [],
        selected: covered
          ? [
              {
                entryId: "e",
                revision: 1,
                entryArtifact: {
                  repository: "research",
                  commit: "c".repeat(40),
                  path: "r.json",
                  hash: h("d"),
                },
                evidence: {
                  kind: "external",
                  url: "https://example.org/evidence",
                  title: "Synthetic evidence",
                  retrievedAt: "2026-10-01T00:00:00Z",
                  lastCheckedAt: "2026-10-01T00:00:00Z",
                  passage: `Evidence about: ${claim.statement}`,
                },
              },
            ]
          : [],
        outdated: [],
        gaps: covered ? [] : [claim.statement],
        rejected: [],
        omitted: [],
        modelVersion: "m",
        promptVersion: "p",
      };
      return result;
    },
  };
  return { k, calls: () => calls };
}

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-coordinator-"));
  await mkdir(join(dir, "drafts"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "drafts"), repository: "drafts" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
const coordinator = (k: ResearchKeeper) =>
  new ResearchCoordinator({ keeper: k, operations, artifacts, owner: "coord" });
const requests = () => operations.duePendingEvents(100, RESEARCH_REQUESTED_SUBJECT);
const briefs = () => operations.duePendingEvents(100, BRIEF_READY_SUBJECT);

describe("ResearchCoordinator", () => {
  it("reuses the corpus immediately when it covers every claim", async () => {
    const c = coordinator(keeper(new Set([TOWERS, FEES])).k);
    const r = await c.advance(post("p1", [TOWERS, FEES]));
    expect(r).toMatchObject({ kind: "brief", result: { kind: "saved" } });
    expect(requests()).toEqual([]);
    expect(briefs()).toHaveLength(1);
  });

  it("requests research, waits without holding anything, and hands off the brief on completion", async () => {
    const corpus = new Set([FEES]);
    const c = coordinator(keeper(corpus).k);
    const waiting = await c.advance(post("p1", [TOWERS, FEES]));
    expect(waiting).toEqual({ kind: "waiting", needIds: [researchNeedId(TOWERS)] });
    expect(JSON.parse(requests()[0]!.payload).data).toMatchObject({
      needId: researchNeedId(TOWERS),
      question: TOWERS,
      gaps: [TOWERS],
    });
    expect(briefs()).toEqual([]);
    // Research runs elsewhere and adds to the corpus, then reports completion.
    corpus.add(TOWERS);
    const done = await c.onResearchCompleted({ needId: researchNeedId(TOWERS), outcome: "saved" });
    expect(done).toMatchObject({
      kind: "recorded",
      advanced: [{ outcome: { kind: "brief", result: { kind: "saved" } } }],
    });
    expect(briefs()).toHaveLength(1);
  });

  it("requests one shared need once for several posts and resumes them all", async () => {
    const corpus = new Set<string>();
    const c = coordinator(keeper(corpus).k);
    await c.advance(post("p1", [TOWERS]));
    await c.advance(post("p2", [TOWERS]));
    await c.advance(post("p1", [TOWERS]));
    expect(requests()).toHaveLength(1);
    corpus.add(TOWERS);
    const done = await c.onResearchCompleted({ needId: researchNeedId(TOWERS), outcome: "saved" });
    expect(done.kind === "recorded" && done.advanced).toHaveLength(2);
    expect(briefs()).toHaveLength(2);
  });

  it("ignores repeated completion events", async () => {
    const corpus = new Set<string>();
    const c = coordinator(keeper(corpus).k);
    await c.advance(post("p1", [TOWERS]));
    corpus.add(TOWERS);
    await c.onResearchCompleted({ needId: researchNeedId(TOWERS), outcome: "saved" });
    expect(
      await c.onResearchCompleted({ needId: researchNeedId(TOWERS), outcome: "saved" }),
    ).toEqual({ kind: "duplicate" });
    expect(briefs()).toHaveLength(1);
  });

  it("pauses on paused research, resumes on a later result, and treats failed research as an evidence gap", async () => {
    const corpus = new Set([FEES]);
    const c = coordinator(keeper(corpus).k);
    await c.advance(post("p1", [TOWERS, FEES]));
    expect(
      await c.onResearchCompleted({
        needId: researchNeedId(TOWERS),
        outcome: "paused",
        reason: "credit",
      }),
    ).toEqual({
      kind: "recorded",
      advanced: [],
    });
    expect(await c.advance(post("p1", [TOWERS, FEES]))).toEqual({
      kind: "paused",
      needIds: [researchNeedId(TOWERS)],
    });
    expect(requests()).toHaveLength(1);
    const failed = await c.onResearchCompleted({
      needId: researchNeedId(TOWERS),
      outcome: "failed",
    });
    expect(failed).toMatchObject({
      kind: "recorded",
      advanced: [{ outcome: { kind: "brief", result: { kind: "saved" } } }],
    });
    const brief = JSON.parse(briefs()[0]!.payload).data;
    expect(brief).toMatchObject({ claims: 1, evidenceGaps: 1 });
  });

  it("registers posts that arrive while research is paused, and resumes them later", async () => {
    const corpus = new Set<string>();
    const c = coordinator(keeper(corpus).k);
    await c.advance(post("p1", [TOWERS]));
    await c.onResearchCompleted({ needId: researchNeedId(TOWERS), outcome: "paused" });
    expect(await c.advance(post("p2", [TOWERS]))).toMatchObject({ kind: "paused" });
    corpus.add(TOWERS);
    const done = await c.onResearchCompleted({ needId: researchNeedId(TOWERS), outcome: "saved" });
    expect(done.kind === "recorded" && done.advanced.map((a) => a.post).sort()).toEqual([
      expect.stringContaining("pub/p1@"),
      expect.stringContaining("pub/p2@"),
    ]);
  });

  it("finishes an interrupted fan-out when the completion event is redelivered", async () => {
    const corpus = new Set<string>();
    const c = coordinator(keeper(corpus).k);
    await c.advance(post("p1", [TOWERS]));
    corpus.add(TOWERS);
    // The result was recorded, then the process stopped before resuming waiters.
    operations.reconcileCompleted(
      `research-result:${researchNeedId(TOWERS)}`,
      { outcome: "saved" },
      [],
    );
    const redelivered = await c.onResearchCompleted({
      needId: researchNeedId(TOWERS),
      outcome: "saved",
    });
    expect(redelivered).toMatchObject({
      kind: "recorded",
      advanced: [{ outcome: { kind: "brief" } }],
    });
    expect(
      await c.onResearchCompleted({ needId: researchNeedId(TOWERS), outcome: "saved" }),
    ).toEqual({ kind: "duplicate" });
  });

  it("keeps a waiter eligible when its brief handoff fails transiently", async () => {
    const corpus = new Set<string>();
    let failWrites = true;
    const flaky = {
      write: async (path: string, content: string) => {
        if (failWrites) throw new Error("git down");
        return artifacts.write(path, content);
      },
      lookup: (path: string) => artifacts.lookup(path),
    };
    const c = new ResearchCoordinator({
      keeper: keeper(corpus).k,
      operations,
      artifacts: flaky,
      owner: "coord",
    });
    await c.advance(post("p1", [TOWERS]));
    corpus.add(TOWERS);
    const first = await c.onResearchCompleted({ needId: researchNeedId(TOWERS), outcome: "saved" });
    expect(first).toMatchObject({
      advanced: [{ outcome: { kind: "brief", result: { kind: "failed" } } }],
    });
    failWrites = false;
    const again = await c.onResearchCompleted({ needId: researchNeedId(TOWERS), outcome: "saved" });
    expect(again).toMatchObject({
      advanced: [{ outcome: { kind: "brief", result: { kind: "saved" } } }],
    });
  });

  it("re-assesses a claim whose research finished after its first assessment", async () => {
    const corpus = new Set<string>();
    const needId = researchNeedId(TOWERS);
    const base = keeper(corpus).k;
    let first = true;
    // Research completes, and the corpus updates, right after the first assessment.
    const racing: ResearchKeeper = {
      async assess(claim, signal) {
        const r = await base.assess(claim, signal);
        if (first) {
          first = false;
          corpus.add(TOWERS);
          operations.reconcileCompleted(`research-result:${needId}`, { outcome: "saved" }, []);
        }
        return r;
      },
    };
    const r = await coordinator(racing).advance(post("p1", [TOWERS]));
    expect(r).toMatchObject({ kind: "brief", result: { kind: "saved" } });
    expect(JSON.parse(briefs()[0]!.payload).data).toMatchObject({ claims: 1, evidenceGaps: 0 });
  });

  it("retries while an interrupted request is unrecorded, then requests it", async () => {
    const c = coordinator(keeper(new Set()).k);
    // Another attempt claimed the request and stopped before recording it.
    operations.claim(`research-request:${researchNeedId(TOWERS)}`, "crashed", 60_000);
    expect(await c.advance(post("p1", [TOWERS]))).toEqual({
      kind: "retry",
      reason: "request-in-flight",
    });
    expect(requests()).toEqual([]);
    const db = (operations as unknown as { db: { prepare(s: string): { run(): void } } }).db;
    db.prepare(
      "UPDATE operations SET lease_expires_at = 0 WHERE key LIKE 'research-request:%'",
    ).run();
    expect(await c.advance(post("p1", [TOWERS]))).toMatchObject({ kind: "waiting" });
    expect(requests()).toHaveLength(1);
  });

  it("retries when the research keeper fails, without requesting anything", async () => {
    const c = coordinator(keeper(new Set(), true).k);
    expect(await c.advance(post("p1", [TOWERS]))).toEqual({
      kind: "retry",
      reason: "keeper:provider-failed",
    });
    expect(requests()).toEqual([]);
  });

  it("rejects malformed completion events", async () => {
    const c = coordinator(keeper(new Set()).k);
    await expect(c.onResearchCompleted({ needId: "x", outcome: "saved" })).rejects.toThrow();
  });
});

describe("OperationStore read-only views", () => {
  it("reports status and lists by prefix without claiming", () => {
    const held = operations.claim("ns:a", "w", 1_000);
    if (held.kind !== "claimed") throw new Error("claim");
    operations.complete(held.claim, { x: 1 }, []);
    operations.recordPermanentFailure("ns:b", "gave-up");
    operations.claim("other:c", "w", 1_000);
    expect(operations.operationStatus("ns:a")).toMatchObject({
      status: "completed",
      artifact: { x: 1 },
      exhausted: false,
    });
    expect(operations.operationStatus("ns:b")).toMatchObject({
      status: "failed",
      exhausted: true,
      errorCode: "gave-up",
    });
    expect(operations.operationStatus("missing")).toBeUndefined();
    expect(operations.listOperations("ns:").map((o) => o.key)).toEqual(["ns:a", "ns:b"]);
    expect(operations.listOperations("ns_").map((o) => o.key)).toEqual([]);
    expect(operations.listOperations("ns:", 1).map((o) => o.key)).toEqual(["ns:a"]);
    expect(operations.listOperations("ns:", 1, "ns:a").map((o) => o.key)).toEqual(["ns:b"]);
    expect(operations.listOperations("ns:", 1, "ns:b")).toEqual([]);
  });
});
