import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { WebAdapterError } from "../../src/controllers/research-web.js";
import {
  assembleStage,
  discoverStage,
  failedJob,
  inventoryStage,
  retrieveStage,
  type StagedResearchDeps,
} from "../../src/research/staged-research.js";
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
    assemble: (d, i) => assembleStage(deps, d, i),
    failed: async (r, f) => failedJob(r, f as never),
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
        retrieve: async () => {
          throw new Error("crash");
        },
      },
    };
    await expect(runResearch(run.ctx, crashing, request)).rejects.toThrow("crash");
    expect(s.calls.n).toBe(1);
    // Replay of the same invocation: discovery and inventory come from the journal.
    const job = await runResearch(run.ctx, stages, request);
    expect(s.calls.n).toBe(1);
    expect(run.names).toEqual(
      expect.arrayContaining([
        "research-discover",
        "research-inventory",
        "research-retrieve-0",
        "research-assemble",
      ]),
    );
    expect(job).toMatchObject({
      status: "finished",
      result: { outcome: expect.stringMatching(/complete/) },
    });
    // Exact artifact refs: the result is the assembled one under the discovery.
    expect(job.resultRef?.path).toMatch(/^research-discovery\/.+\/assembled\/result\.json$/);
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
    );
    expect(run.names).toContain("research-retrieve-1");
    // The adapter-only fake provenance always leaves a gap; both sources are archived.
    const manifest = JSON.parse(
      await artifacts.read(
        (await artifacts.lookup(
          job.resultRef!.path.replace("result.json", "manifest.json"),
        )) as never,
      ),
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
    );
    expect(job.result).toMatchObject({ outcome: "failed", failure: "provider-error" });
    expect(run.names).not.toContain("research-inventory");
  });

  it("keeps the legacy single step when staged research is not configured", async () => {
    const run = journalCtx();
    const legacy = { jobId: "research-" + "0".repeat(32), status: "finished" as const };
    const job = await runResearch(run.ctx, { research: async () => legacy }, request);
    expect(job).toEqual(legacy);
    expect(run.names).toEqual(["research"]);
  });
});
