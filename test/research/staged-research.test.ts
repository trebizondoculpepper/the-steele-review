import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import { WebAdapterError } from "../../src/controllers/research-web.js";
import {
  assembleStage,
  discoverStage,
  existingJob,
  finishFailedStage,
  inventoryStage,
  retrieveStage,
  retrievalIds,
  retrieveOneStage,
  supportStage,
  type StagedResearchDeps,
} from "../../src/research/staged-research.js";
import { researchJobId } from "../../src/research/job.js";
import { researchDocumentKind } from "../../src/research/research-index.js";
import { runResearch, type ResearchStages } from "../../src/workflow/article-run.js";

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-staged-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const request = {
  schemaVersion: 1 as const,
  origin: "manual" as const,
  subject: "Mast safety",
  pass: 1,
  claims: [],
  corpusRefs: [],
};

/** A deterministic Sonar stand-in that counts paid calls. */
function sonar(fail?: Error) {
  const calls = { n: 0 };
  return {
    calls,
    client: {
      model: "fake/sonar",
      async research() {
        calls.n++;
        if (fail) throw fail;
        return {
          model: "fake/sonar",
          report: "# Report\n\nSee https://ok.example/a and https://flaky.example/b.",
          citations: ["https://ok.example/a", "https://flaky.example/b"],
        };
      },
    },
  };
}

/** A Restate-like journal: a completed named step is replayed, never rerun. */
function journalCtx(journal = new Map<string, unknown>()) {
  const names: string[] = [];
  return {
    journal,
    names,
    ctx: {
      async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
        names.push(name);
        if (journal.has(name)) return journal.get(name) as T;
        const value = await fn();
        journal.set(name, JSON.parse(JSON.stringify(value)));
        return value;
      },
      async sleep() {},
    },
  };
}

function stagesFor(deps: StagedResearchDeps): ResearchStages {
  return {
    discover: (r) => discoverStage(deps, r),
    inventory: (d) => inventoryStage(deps, d),
    retrieve: (i) => retrieveStage(deps, i),
    ids: (i) => retrievalIds(deps, i),
    support: (d, i, id) => supportStage(deps, d, i, id),
    retrieveOne: (i, id) => retrieveOneStage(deps, i, id),
    assemble: (d, i) => assembleStage(deps, d, i),
    failed: (r, f) => finishFailedStage(deps, r, f as never),
    existing: (r) => existingJob(deps, r),
    rounds: 3,
    roundDelayMs: 1,
  };
}

const deps = (
  s: ReturnType<typeof sonar>,
  fetcher: StagedResearchDeps["fetcher"],
): StagedResearchDeps => ({
  artifacts,
  operations,
  sonar: s.client as never,
  fetcher,
  owner: "test",
  limits: {
    maxSources: 10,
    maxAttempts: 1,
    timeoutMs: 1_000,
    maxSourceChars: 10_000,
    backoffMs: 1,
  },
});

describe("staged research through Restate (#593)", { timeout: 60_000 }, () => {
  it("runs named stages and resumes after an interrupted retrieval without rediscovering", async () => {
    const s = sonar();
    let crash = true;
    const fetcher = {
      async fetch(url: string) {
        if (crash && url === "https://flaky.example/b") {
          crash = false;
          throw new Error("worker crashed mid-retrieval");
        }
        return { url, title: url, text: `Text of ${url}` };
      },
    };
    const run = journalCtx();
    const stages = {
      research: async () => {
        throw new Error("legacy path must not run");
      },
      researchStages: stagesFor(deps(s, fetcher)),
    };
    // First invocation: the retrieval step throws (a crash), so the invocation fails.
    // A non-WebAdapter error is classified as a transient fetch failure and retried
    // in later rounds; simulate an outright crash by making the step itself throw.
    const crashing = {
      ...stages,
      researchStages: {
        ...stages.researchStages,
        retrieveOne: async () => {
          throw new Error("crash");
        },
      },
    };
    await expect(runResearch(run.ctx, crashing, request, "staged")).rejects.toThrow("crash");
    expect(s.calls.n).toBe(1);
    // Replay of the same invocation: discovery and inventory come from the journal.
    const job = await runResearch(run.ctx, stages, request, "staged");
    expect(s.calls.n).toBe(1);
    expect(run.names).toEqual(
      expect.arrayContaining([
        "research-existing",
        "research-discover",
        "research-inventory",
        "research-assemble",
      ]),
    );
    expect(job).toMatchObject({
      status: "finished",
      result: { outcome: expect.stringMatching(/complete/) },
    });
    // Found by its stable job ID, with compatible request and report for readers.
    expect(job.resultRef?.path).toMatch(/^research-jobs\/research-[0-9a-f]{32}\/result\.json$/);
    expect(job.result?.manifest?.path).toMatch(
      /^research-discovery\/.+\/assembled\/manifest\.json$/,
    );
    expect(await artifacts.lookup(`research-jobs/${job.jobId}/request.json`)).toBeDefined();
    expect(await artifacts.lookup(`research-jobs/${job.jobId}/report.md`)).toBeDefined();
    // A later invocation reuses it with no provider call, even with other settings.
    const again = journalCtx();
    const reused = await runResearch(again.ctx, stages, request, "staged");
    expect(s.calls.n).toBe(1);
    expect(again.names).toEqual(["research-existing"]);
    expect(reused.resultRef?.path).toBe(job.resultRef?.path);
  });

  it("retries transient retrievals in bounded rounds, keeping other results", async () => {
    const s = sonar();
    let flaky = 0;
    const fetcher = {
      async fetch(url: string) {
        if (url === "https://flaky.example/b" && flaky++ < 1)
          throw new WebAdapterError("rate-limited", 429);
        return { url, title: url, text: `Text of ${url}` };
      },
    };
    const run = journalCtx();
    const job = await runResearch(
      run.ctx,
      { research: async () => ({}) as never, researchStages: stagesFor(deps(s, fetcher)) },
      request,
      "staged",
    );
    // Each URL is its own named step; only the flaky one has a second round.
    const retrievals = run.names.filter((n) => n.startsWith("research-retrieve-"));
    expect(retrievals.filter((n) => n.endsWith("-0"))).toHaveLength(2);
    expect(retrievals.filter((n) => n.endsWith("-1"))).toHaveLength(1);
    // The adapter-only fake provenance always leaves a gap; both sources are archived.
    const manifest = JSON.parse(
      await artifacts.read((await artifacts.lookup(job.result!.manifest!.path))!),
    );
    expect(manifest.citations.map((c: { retrieval: string }) => c.retrieval)).toEqual([
      "archived",
      "archived",
    ]);
  });

  it("ends a provider failure as a failed result, never as an evidence gap", async () => {
    const s = sonar(new Error("provider down"));
    const run = journalCtx();
    const job = await runResearch(
      run.ctx,
      {
        research: async () => ({}) as never,
        researchStages: stagesFor(
          deps(s, {
            fetch: async () => {
              throw new Error("x");
            },
          }),
        ),
      },
      request,
      "staged",
    );
    expect(job.result).toMatchObject({ outcome: "failed", failure: "provider-error" });
    // Persisted with its completion event, like the legacy runner.
    expect(job.resultRef?.path).toMatch(/^research-jobs\/.+\/result\.json$/);
    expect(operations.pendingEventStatus(job.jobId)).toBeDefined();
    expect(run.names).not.toContain("research-inventory");
  });

  it("keeps credit exhaustion recoverable: nothing is finalised", async () => {
    const out = await finishFailedStage({ artifacts, operations }, request, "budget-exceeded");
    expect(out.result).toMatchObject({ outcome: "failed", failure: "budget-exceeded" });
    expect(out.resultRef).toBeUndefined();
    expect(operations.pendingEventStatus(out.jobId)).toBeUndefined();
    // An inspectable record of the stopped attempt, not a final result.
    const attempts = await artifacts.list(`research-jobs/${out.jobId}/attempts`, 10);
    expect(attempts).toHaveLength(1);
    expect(await artifacts.lookup(`research-jobs/${out.jobId}/result.json`)).toBeUndefined();
  });

  it("keeps the legacy single step when staged research is not configured", async () => {
    const run = journalCtx();
    const legacy = { jobId: "research-" + "0".repeat(32), status: "finished" as const };
    const job = await runResearch(run.ctx, { research: async () => legacy }, request);
    expect(job).toEqual(legacy);
    expect(run.names).toEqual(["research"]);
  });

  it("replays a legacy invocation as one step even with staged stages available", async () => {
    const run = journalCtx();
    const legacy = { jobId: "research-" + "1".repeat(32), status: "finished" as const };
    const job = await runResearch(
      run.ctx,
      {
        research: async () => legacy,
        researchStages: stagesFor(
          deps(sonar(), {
            fetch: async () => {
              throw new Error("no");
            },
          }),
        ),
      },
      request,
    );
    expect(job).toEqual(legacy);
    expect(run.names).toEqual(["research"]);
  });

  it("reuses a saved terminal failure instead of buying discovery again", async () => {
    const failing = sonar(new Error("provider down"));
    const d = deps(failing, {
      fetch: async () => {
        throw new Error("no");
      },
    });
    const first = await runResearch(
      journalCtx().ctx,
      { research: async () => ({}) as never, researchStages: stagesFor(d) },
      request,
      "staged",
    );
    expect(first.result?.failure).toBe("provider-error");
    // A recovery is a new invocation (new journal): the saved result is reused.
    const healthy = sonar();
    const again = journalCtx();
    const job = await runResearch(
      again.ctx,
      { research: async () => ({}) as never, researchStages: stagesFor(deps(healthy, d.fetcher)) },
      request,
      "staged",
    );
    expect(healthy.calls.n).toBe(0);
    expect(job.resultRef?.path).toBe(first.resultRef?.path);
    expect(again.names).toEqual(["research-existing"]);
  });
});

describe("staged outputs are searchable (#593)", () => {
  it("classifies assembled reports and citation snapshots", () => {
    expect(researchDocumentKind("research-discovery/req-a/disc-b/assembled/report.md")).toBe(
      "research-report",
    );
    expect(researchDocumentKind("research-discovery/req-a/disc-b/citations/snapshots/x.json")).toBe(
      "source-snapshot",
    );
    expect(
      researchDocumentKind("research-discovery/req-a/disc-b/citations/inventory.json"),
    ).toBeUndefined();
  });

  it("ends retrieval credit exhaustion as a recoverable credit failure", async () => {
    const s = sonar();
    const run = journalCtx();
    const job = await runResearch(
      run.ctx,
      {
        research: async () => ({}) as never,
        researchStages: stagesFor(
          deps(s, {
            fetch: async () => {
              throw new WebAdapterError("credit-exhausted", 402);
            },
          }),
        ),
      },
      request,
      "staged",
    );
    expect(job.result).toMatchObject({ outcome: "failed", failure: "budget-exceeded" });
    expect(job.resultRef).toBeUndefined();
    expect(run.names).toContain("research-failed");
    expect(run.names).not.toContain("research-assemble");
  });

  it("records a missing completion event before reusing a saved result", async () => {
    const jobId = researchJobId(request);
    await artifacts.write(
      `research-jobs/${jobId}/result.json`,
      JSON.stringify({
        schemaVersion: 1,
        jobId,
        outcome: "failed",
        failure: "provider-error",
        finishedAt: "2026-11-22T00:00:00.000Z",
      }),
    );
    expect(operations.pendingEventStatus(jobId)).toBeUndefined();
    const job = await existingJob({ artifacts, operations }, request);
    expect(job?.result?.failure).toBe("provider-error");
    expect(operations.pendingEventStatus(jobId)).toBeDefined();
  });
});

describe("staged support handoff (#593)", { timeout: 60_000 }, () => {
  const judgeWith = (
    fn: (url: string, source: string) => { findingId: string; passage: string }[],
  ) => ({
    calls: 0,
    async judge(input: { url: string; source: string; findings: { id: string }[] }) {
      this.calls++;
      return {
        passages: fn(input.url, input.source).map((p) => ({
          ...p,
          findingId: p.findingId || input.findings[0]!.id,
        })),
      };
    },
  });
  const fetchOk = {
    fetch: async (url: string) => ({ url, title: url, text: `Text of ${url} with a key fact.` }),
  };

  it("judges each archived source as its own step and records supported passages", async () => {
    const judge = judgeWith((url) =>
      url.includes("ok.example")
        ? [{ findingId: "", passage: "a key fact" }]
        : [{ findingId: "", passage: "not in the source" }],
    );
    const d = { ...deps(sonar(), fetchOk), judge: judge as never, monitoredHosts: [] };
    const run = journalCtx();
    const job = await runResearch(
      run.ctx,
      { research: async () => ({}) as never, researchStages: stagesFor(d) },
      request,
      "staged",
    );
    expect(run.names.filter((n) => n.startsWith("research-support-"))).toHaveLength(2);
    const manifest = JSON.parse(
      await artifacts.read((await artifacts.lookup(job.result!.manifest!.path))!),
    );
    const byUrl = new Map(manifest.citations.map((c: { url: string }) => [c.url, c]));
    expect(byUrl.get("https://ok.example/a")).toMatchObject({
      support: "supported",
      passages: [{ passage: "a key fact" }],
    });
    // A passage that is not verbatim in the source never counts.
    expect(byUrl.get("https://flaky.example/b")).toMatchObject({
      support: "unverified",
      passages: [],
    });
    expect(manifest.gaps.join(" ")).toMatch(/no verified supporting passage/);
    expect(manifest.gaps.join(" ")).not.toMatch(/not yet assessed/);
    // A replay reuses saved judgements: no further judge calls.
    const before = judge.calls;
    await runResearch(
      journalCtx().ctx,
      { research: async () => ({}) as never, researchStages: stagesFor(d) },
      request,
      "staged",
    );
    expect(judge.calls).toBe(before);
  });

  it("never reuses a verdict made under another judge prompt", async () => {
    const first = Object.assign(
      judgeWith(() => [{ findingId: "", passage: "a key fact" }]),
      {
        identity: "support-judge-v1+sha256:aaaa",
      },
    );
    const d1 = { ...deps(sonar(), fetchOk), judge: first as never };
    await runResearch(
      journalCtx().ctx,
      { research: async () => ({}) as never, researchStages: stagesFor(d1) },
      request,
      "staged",
    );
    const second = Object.assign(
      judgeWith(() => []),
      { identity: "support-judge-v2+sha256:bbbb" },
    );
    const d2 = { ...deps(sonar(), fetchOk), judge: second as never };
    // A new invocation under the new prompt judges again (the old verdict is kept, not reused).
    for (const id of await retrievalIds(
      d2,
      (await artifacts.lookup(
        (await artifacts.list("research-discovery", 50)).find((p) => p.endsWith("inventory.json"))!,
      ))!,
    )) {
      await supportStage(
        d2,
        (await artifacts.lookup(
          (await artifacts.list("research-discovery", 50)).find(
            (p) => p.endsWith("/result.json") && !p.includes("assembled"),
          )!,
        ))!,
        (await artifacts.lookup(
          (await artifacts.list("research-discovery", 50)).find((p) =>
            p.endsWith("inventory.json"),
          )!,
        ))!,
        id,
      );
    }
    expect(second.calls).toBe(2);
    expect(first.calls).toBe(2);
  });

  it("keeps the claimant's own pages unverified and labelled", async () => {
    const judge = judgeWith(() => [{ findingId: "", passage: "a key fact" }]);
    const d = { ...deps(sonar(), fetchOk), judge: judge as never, monitoredHosts: ["ok.example"] };
    const job = await runResearch(
      journalCtx().ctx,
      { research: async () => ({}) as never, researchStages: stagesFor(d) },
      request,
      "staged",
    );
    const manifest = JSON.parse(
      await artifacts.read((await artifacts.lookup(job.result!.manifest!.path))!),
    );
    expect(
      manifest.citations.find((c: { url: string }) => c.url === "https://ok.example/a"),
    ).toMatchObject({
      support: "unverified",
      sourceType: "monitored-source",
    });
  });

  it("stops recoverably when the judge runs out of credit", async () => {
    const d = {
      ...deps(sonar(), fetchOk),
      judge: {
        judge: async () => {
          throw new ModelProviderError("credit-exhausted", 402);
        },
      } as never,
    };
    const run = journalCtx();
    const job = await runResearch(
      run.ctx,
      { research: async () => ({}) as never, researchStages: stagesFor(d) },
      request,
      "staged",
    );
    expect(job.result).toMatchObject({ outcome: "failed", failure: "budget-exceeded" });
    expect(run.names).not.toContain("research-assemble");
  });
});
