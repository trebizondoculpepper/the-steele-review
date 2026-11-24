import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import * as clients from "@restatedev/restate-sdk-clients";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  CorpusRefinementInputSchema,
  corpusRefinementPath,
  syntheticBatch,
  type IdeasResult,
} from "../../src/corpus-refinement/contracts.js";
import {
  STUB_CORPUS_REFINEMENT,
  corpusRefinementWorkflow,
  type CorpusRefinementLogic,
} from "../../src/corpus-refinement/workflow.js";

// Isolated test repository; deterministic stubs; no model calls (#830).
let dir: string;
let artifacts: GitArtifactStore;
let env: RestateTestEnvironment;
let ingress: clients.Ingress;
const calls = { coverage: 0, ideas: 0, underlying: 0 };
const failMiddleOnce = new Set<string>();
const crashAfterSave = new Set<string>();
const logic: CorpusRefinementLogic = {
  version: STUB_CORPUS_REFINEMENT.version,
  checkCoverage: async (input) => (calls.coverage++, STUB_CORPUS_REFINEMENT.checkCoverage(input)),
  mapClaimsToIdeas: async (input, coverage) => {
    calls.ideas++;
    if (failMiddleOnce.delete(input.runId)) throw new Error("synthetic transient failure");
    return STUB_CORPUS_REFINEMENT.mapClaimsToIdeas(input, coverage);
  },
  mapIdeasToUnderlying: async (ideas) => (
    calls.underlying++,
    STUB_CORPUS_REFINEMENT.mapIdeasToUnderlying(ideas)
  ),
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "corpus-refinement-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "corpus-test" });
  await artifacts.initialise();
  env = await RestateTestEnvironment.start(
    {
      services: [corpusRefinementWorkflow({ artifacts, logic })],
      serviceEndpointAccess: "docker-host",
    },
    () => new RestateContainer("1.8.1"),
  );
  ingress = clients.connect({ url: env.baseUrl() });
}, 240_000);
afterAll(async () => {
  await env?.stop();
  await rm(dir, { recursive: true, force: true });
});

const client = (runId: string) =>
  ingress.workflowClient<ReturnType<typeof corpusRefinementWorkflow>>(
    { name: "CorpusRefinement" },
    runId,
  );

describe("Corpus Refinement prototype on Restate (#830)", { timeout: 120_000 }, () => {
  it("runs the three stages in order, handing each exact saved reference forward", async () => {
    const before = { ...calls };
    const wf = client("run-ordered");
    await wf.workflowSubmit(syntheticBatch("run-ordered", 10));
    const out = await wf.workflowAttach();
    expect(out.stages.map((s) => s.stage)).toEqual([
      "check-coverage",
      "map-claims-to-ideas",
      "map-ideas-to-underlying",
    ]);
    for (const s of out.stages)
      expect(s.artifact.path).toBe(corpusRefinementPath("run-ordered", s.stage));
    // Each artifact is the exact versioned one the next stage read.
    const ideas = JSON.parse(await artifacts.read(out.stages[1]!.artifact as never))
      .value as IdeasResult;
    const underlying = JSON.parse(await artifacts.read(out.stages[2]!.artifact as never)).value;
    expect(underlying.underlying[0].ideaIds).toEqual(ideas.ideas.map((i) => i.id));
    expect(calls).toEqual({
      coverage: before.coverage + 1,
      ideas: before.ideas + 1,
      underlying: before.underlying + 1,
    });
  });

  it("treats a duplicate submission of the same run ID as the same run", async () => {
    const wf = client("run-duplicate");
    const first = await wf.workflowSubmit(syntheticBatch("run-duplicate", 4));
    const firstResult = await wf.workflowAttach();
    const before = { ...calls };
    const second = await wf.workflowSubmit(syntheticBatch("run-duplicate", 4));
    expect(second.status).toBe("PreviouslyAccepted");
    expect(second.invocationId).toBe(first.invocationId);
    expect(await wf.workflowAttach()).toEqual(firstResult);
    // No stage ran again.
    expect(calls).toEqual(before);
  });

  it("recovers when the middle stage fails once, without repeating the first", async () => {
    failMiddleOnce.add("run-recover");
    const before = { ...calls };
    const wf = client("run-recover");
    await wf.workflowSubmit(syntheticBatch("run-recover", 6));
    const out = await wf.workflowAttach();
    expect(out.stages).toHaveLength(3);
    expect(calls.coverage).toBe(before.coverage + 1);
    // The middle stage ran twice (one failure, one success); the last once.
    expect(calls.ideas).toBe(before.ideas + 2);
    expect(calls.underlying).toBe(before.underlying + 1);
    // One artifact per stage, plus the pinned batch they all read (#856).
    expect((await artifacts.list("corpus-refinement/run-recover", 10)).sort()).toEqual(
      ["batch", "check-coverage", "map-claims-to-ideas", "map-ideas-to-underlying"].map(
        (name) => `corpus-refinement/run-recover/${name}.json`,
      ),
    );
  });

  it("fails rather than reuse a stale artifact saved from other inputs or logic", async () => {
    // As after a reset Restate journal: the repository already holds this run
    // ID's first-stage artifact, produced from something else.
    await artifacts.write(
      corpusRefinementPath("run-stale", "check-coverage"),
      JSON.stringify({
        schemaVersion: 1,
        stage: "check-coverage",
        runId: "run-stale",
        identity: "sha256:" + "0".repeat(64),
        value: { covered: ["x"], uncovered: [] },
      }),
    );
    const before = { ...calls };
    const wf = client("run-stale");
    await wf.workflowSubmit(syntheticBatch("run-stale", 3));
    await expect(wf.workflowAttach()).rejects.toThrow(/saved from different inputs or logic/);
    // Nothing downstream ran on the stale result.
    expect(calls.ideas).toBe(before.ideas);
    expect(calls.underlying).toBe(before.underlying);
  });

  it("rejects a malformed artifact even when it carries the expected identity (#848)", async () => {
    const input = CorpusRefinementInputSchema.parse(syntheticBatch("run-malformed", 3));
    const identity = `sha256:${createHash("sha256")
      .update(JSON.stringify({ stage: "check-coverage", logic: logic.version, inputs: input }))
      .digest("hex")}`;
    await artifacts.write(
      corpusRefinementPath("run-malformed", "check-coverage"),
      JSON.stringify({
        schemaVersion: 1,
        stage: "check-coverage",
        runId: "run-malformed",
        identity,
        value: { covered: "not-a-list" },
      }),
    );
    const before = { ...calls };
    const wf = client("run-malformed");
    await wf.workflowSubmit(input);
    await expect(wf.workflowAttach()).rejects.toThrow(/not usable \(payload:covered\)/);
    expect(calls.ideas).toBe(before.ideas);
    expect(calls.underlying).toBe(before.underlying);
  });

  it("recovers from a save that landed before the handoff was recorded (#830)", async () => {
    crashAfterSave.add(corpusRefinementPath("run-crash", "map-claims-to-ideas"));
    const before = { ...calls };
    const wf = client("run-crash");
    await wf.workflowSubmit(syntheticBatch("run-crash", 6));
    const out = await wf.workflowAttach();
    expect(out.stages.map((s) => s.stage)).toHaveLength(3);
    // The middle stage computed once: the retry found its saved artifact
    // (same identity) and reused it instead of computing again.
    expect(calls.ideas).toBe(before.ideas + 1);
    expect(calls.underlying).toBe(before.underlying + 1);
    // Exactly one artifact per stage; the handoff is the saved version.
    // One artifact per stage, plus the pinned batch they all read (#856).
    expect((await artifacts.list("corpus-refinement/run-crash", 10)).sort()).toEqual(
      ["batch", "check-coverage", "map-claims-to-ideas", "map-ideas-to-underlying"].map(
        (name) => `corpus-refinement/run-crash/${name}.json`,
      ),
    );
    expect(out.stages[1]!.artifact.path).toBe(
      corpusRefinementPath("run-crash", "map-claims-to-ideas"),
    );
  });
});
