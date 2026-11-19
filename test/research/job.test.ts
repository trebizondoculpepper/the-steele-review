import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  RESEARCH_COMPLETED_SUBJECT,
  parseResearchCompletedEvent,
  researchCompletedDataJsonSchema,
} from "../../src/events/research-completed-event.js";
import {
  ResearchRequestSchema,
  ResearchResultSchema,
  finishResearchJob,
  openResearchJob,
  researchJobId,
} from "../../src/research/job.js";

const ref = (c: string) => ({
  repository: "content",
  commit: c.repeat(40),
  path: `x/${c}.json`,
  hash: `sha256:${c.repeat(64)}`,
});
const request = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  pass: 1,
  post: {
    publicationId: "pub",
    postId: "p",
    sourceArtifact: ref("a"),
    themeResult: ref("b"),
    claimResult: ref("c"),
  },
  claims: [
    {
      claimRecordId: "claim-1",
      statement: "A treaty prohibits hostile environmental modification",
      themeIds: ["theme-x"],
    },
    {
      claimRecordId: "claim-2",
      statement: "A payment of 56 million funded an attack",
      themeIds: ["theme-x"],
    },
  ],
  question: "Which treaty applies, what does it prohibit, and is the payment documented?",
  corpusRefs: [],
  ...over,
});

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-research-job-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

describe("research job contracts", () => {
  it("derives a stable ID from inputs and pass, independent of claim order", () => {
    const a = researchJobId(request());
    const reordered = researchJobId(request({ claims: [...request().claims].reverse() }));
    expect(reordered).toBe(a);
    expect(researchJobId(request({ question: "Something else?" }))).not.toBe(a);
    const second = researchJobId(request({ pass: 2, previousJobId: a }));
    expect(second).not.toBe(a);
  });

  it("validates requests and results at the boundary", () => {
    expect(() => ResearchRequestSchema.parse(request({ pass: 2 }))).toThrow(); // later pass needs its predecessor
    expect(() =>
      ResearchRequestSchema.parse(request({ previousJobId: `research-${"0".repeat(32)}` })),
    ).toThrow();
    expect(() => ResearchRequestSchema.parse(request({ question: "" }))).toThrow();
    const base = {
      schemaVersion: 1,
      jobId: researchJobId(request()),
      finishedAt: "2026-01-01T00:00:00Z",
    };
    expect(() => ResearchResultSchema.parse({ ...base, outcome: "complete" })).toThrow(); // needs manifest
    expect(() => ResearchResultSchema.parse({ ...base, outcome: "failed" })).toThrow(); // needs reason
    expect(
      ResearchResultSchema.parse({ ...base, outcome: "failed", failure: "timeout" }).outcome,
    ).toBe("failed");
  });
});

describe("durable job lifecycle", () => {
  it("records outcome and completion event once; redelivery reuses the job without new work", async () => {
    const opened = await openResearchJob({ artifacts, operations, request: request() });
    expect(opened.existing).toBeUndefined();
    const manifest = await artifacts.write(`research-jobs/${opened.jobId}/manifest.json`, "{}");
    const done = await finishResearchJob({
      artifacts,
      operations,
      jobId: opened.jobId,
      outcome: "complete-with-gaps",
      manifest,
    });
    expect(done.result.outcome).toBe("complete-with-gaps");
    expect(operations.pendingEventStatus(opened.jobId)).toBe("pending");

    // Redelivery of the same request: same job, saved outcome, nothing new to run.
    const again = await openResearchJob({
      artifacts,
      operations,
      request: request({ claims: [...request().claims].reverse() }),
    });
    expect(again.jobId).toBe(opened.jobId);
    expect(again.existing?.outcome).toBe("complete-with-gaps");
    const due = operations.duePendingEvents(10, RESEARCH_COMPLETED_SUBJECT);
    expect(due).toHaveLength(1);
    const data = parseResearchCompletedEvent(due[0].payload);
    expect(data).toMatchObject({
      jobId: opened.jobId,
      outcome: "complete-with-gaps",
      manifest: { path: manifest.path },
    });
    expect(researchCompletedDataJsonSchema()).toMatchObject({ type: "object" });
  });

  it("recovers the event after a restart between saving the result and recording it", async () => {
    const { jobId } = await openResearchJob({ artifacts, operations, request: request() });
    // Simulate a crash: the result artifact exists but no event was recorded.
    await artifacts.write(
      `research-jobs/${jobId}/result.json`,
      `${JSON.stringify({ schemaVersion: 1, jobId, outcome: "failed", failure: "interrupted", finishedAt: "2026-01-01T00:00:00Z" }, null, 2)}\n`,
    );
    expect(operations.pendingEventStatus(jobId)).toBeUndefined();
    const reopened = await openResearchJob({ artifacts, operations, request: request() });
    expect(reopened.existing?.failure).toBe("interrupted");
    expect(operations.pendingEventStatus(jobId)).toBe("pending");
  });

  it("records a provider failure without a manifest, and never overwrites a finished job", async () => {
    const { jobId } = await openResearchJob({ artifacts, operations, request: request() });
    const failed = await finishResearchJob({
      artifacts,
      operations,
      jobId,
      outcome: "failed",
      failure: "provider-error",
    });
    expect(failed.result).toMatchObject({ outcome: "failed", failure: "provider-error" });
    expect(failed.result.manifest).toBeUndefined();
    // A later, different outcome for the same job is not written over the saved one.
    const manifest = await artifacts.write(`research-jobs/${jobId}/manifest.json`, "{}");
    const retry = await finishResearchJob({
      artifacts,
      operations,
      jobId,
      outcome: "complete",
      manifest,
    });
    expect(retry).toMatchObject({ reused: true, result: { outcome: "failed" } });
    expect(operations.duePendingEvents(10, RESEARCH_COMPLETED_SUBJECT)).toHaveLength(1);
  });

  it("gives a librarian-directed second pass its own job linked to the first", async () => {
    const first = await openResearchJob({ artifacts, operations, request: request() });
    const second = await openResearchJob({
      artifacts,
      operations,
      request: request({
        pass: 2,
        previousJobId: first.jobId,
        question: "Is the 56 million payment documented?",
      }),
    });
    expect(second.jobId).not.toBe(first.jobId);
    const saved = JSON.parse(await artifacts.read(second.requestRef));
    expect(saved.previousJobId).toBe(first.jobId);
  });
});
