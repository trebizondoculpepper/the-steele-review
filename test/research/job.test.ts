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
  InvalidResearchManifestError,
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
  origin: "extraction",
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

const writeManifest = (jobId: string) =>
  artifacts.write(
    `research-jobs/${jobId}/manifest.json`,
    JSON.stringify({
      schemaVersion: 1,
      jobId,
      report: ref("d"),
      citations: [],
      gaps: ["payment record not found"],
      provider: { model: "fixture" },
    }),
  );

describe("durable job lifecycle", () => {
  it("records outcome and completion event once; redelivery reuses the job without new work", async () => {
    const opened = await openResearchJob({
      artifacts,
      operations,
      owner: "test",
      request: request(),
    });
    expect(opened.status).toBe("run");
    const manifest = await writeManifest(opened.jobId);
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
      owner: "test",
      request: request({ claims: [...request().claims].reverse() }),
    });
    expect(again.jobId).toBe(opened.jobId);
    expect(again.status === "finished" && again.existing.outcome).toBe("complete-with-gaps");
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
    const { jobId } = await openResearchJob({
      artifacts,
      operations,
      owner: "test",
      request: request(),
    });
    // Simulate a crash: the result artifact exists but no event was recorded.
    await artifacts.write(
      `research-jobs/${jobId}/result.json`,
      `${JSON.stringify({ schemaVersion: 1, jobId, outcome: "failed", failure: "interrupted", finishedAt: "2026-01-01T00:00:00Z" }, null, 2)}\n`,
    );
    expect(operations.pendingEventStatus(jobId)).toBeUndefined();
    const reopened = await openResearchJob({
      artifacts,
      operations,
      owner: "test",
      request: request(),
    });
    expect(reopened.status === "finished" && reopened.existing.failure).toBe("interrupted");
    expect(operations.pendingEventStatus(jobId)).toBe("pending");
  });

  it("records a provider failure without a manifest, and never overwrites a finished job", async () => {
    const { jobId } = await openResearchJob({
      artifacts,
      operations,
      owner: "test",
      request: request(),
    });
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
    const manifest = await writeManifest(jobId);
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
    const first = await openResearchJob({
      artifacts,
      operations,
      owner: "test",
      request: request(),
    });
    const second = await openResearchJob({
      artifacts,
      operations,
      owner: "test",
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

describe("manual subject requests (#218)", () => {
  const manual = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    origin: "manual",
    subject: "Chemtrail conspiracy theory",
    brief: "Claims that aircraft deliberately spray chemicals.",
    pass: 1,
    claims: [],
    corpusRefs: [],
    ...over,
  });

  it("accepts a subject with an optional brief and gives it a stable identity", () => {
    const a = researchJobId(manual());
    expect(researchJobId(manual({ subject: "Chemtrail   conspiracy theory" }))).toBe(a);
    expect(researchJobId(manual({ brief: "Different brief." }))).not.toBe(a);
    expect(ResearchRequestSchema.parse(manual({ brief: undefined })).subject).toBe(
      "Chemtrail conspiracy theory",
    );
  });

  it("keeps manual and extraction requirements apart", () => {
    expect(() => ResearchRequestSchema.parse(manual({ subject: undefined }))).toThrow();
    expect(() => ResearchRequestSchema.parse(manual({ post: request().post }))).toThrow();
    expect(() => ResearchRequestSchema.parse(request({ subject: "x" }))).toThrow();
    expect(() => ResearchRequestSchema.parse(request({ claims: [] }))).toThrow();
    expect(researchJobId(manual())).not.toBe(researchJobId(request()));
  });
});

describe("review fixes", () => {
  it("lets only one caller run a job at a time, and records a vanished run as interrupted", async () => {
    let clock = 1_000_000;
    operations.close();
    operations = new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock });
    const a = await openResearchJob({
      artifacts,
      operations,
      owner: "a",
      request: request(),
      leaseMs: 60_000,
    });
    const b = await openResearchJob({
      artifacts,
      operations,
      owner: "b",
      request: request(),
      leaseMs: 60_000,
    });
    expect([a.status, b.status]).toEqual(["run", "busy"]);
    clock += 120_000; // a's lease expired without a result
    const c = await openResearchJob({ artifacts, operations, owner: "c", request: request() });
    expect(c.status === "finished" && c.existing).toMatchObject({
      outcome: "failed",
      failure: "interrupted",
    });
  });

  it("refuses invalid manifests and manifests from another job", async () => {
    const { jobId } = await openResearchJob({
      artifacts,
      operations,
      owner: "t",
      request: request(),
    });
    const junk = await artifacts.write(`research-jobs/${jobId}/manifest.json`, "{}");
    await expect(
      finishResearchJob({ artifacts, operations, jobId, outcome: "complete", manifest: junk }),
    ).rejects.toThrow(InvalidResearchManifestError);
    const other = researchJobId(request({ question: "Another question?" }));
    const foreign = await writeManifest(other);
    await expect(
      finishResearchJob({ artifacts, operations, jobId, outcome: "complete", manifest: foreign }),
    ).rejects.toThrow("another job");
    expect(operations.pendingEventStatus(jobId)).toBeUndefined();
  });

  it("rejects repeated claim IDs so identity cannot depend on input order", () => {
    const dup = request({
      claims: [
        { claimRecordId: "claim-1", statement: "s", themeIds: ["a"] },
        { claimRecordId: "claim-1", statement: "s", themeIds: ["b"] },
      ],
    });
    expect(() => ResearchRequestSchema.parse(dup)).toThrow();
  });
});
