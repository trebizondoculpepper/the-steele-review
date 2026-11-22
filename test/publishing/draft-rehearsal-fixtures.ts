import { createHash } from "node:crypto";
import type { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { OperationStore } from "../../src/controllers/operation-store.js";
import { OwnerDraftRequestSchema } from "../../src/content/owner-draft-authorization.js";
import { artifactRef, artifactReference } from "../../src/drafting/publication-payload.js";
import { prepareJudgeRecovery } from "../../src/workflow/editorial-judge-recovery-submission.js";
import { runEditorialLoop } from "../../src/workflow/editorial-loop.js";
import { editorialStages } from "../../src/workflow/editorial-stages.js";
import { writeOnce } from "../../src/research/job.js";
import { deniedContinuationFixture } from "../workflow/editorial-recovery-fixtures.js";
import { REVISE } from "../workflow/editorial-continuation-fixtures.js";
import { WRITER } from "./approval-fixtures.js";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Real retained writer/role/mechanical records and typed state; all models are local fakes. */
export async function retainedRehearsalFixture(
  content: GitArtifactStore,
  operations: OperationStore,
) {
  const denied = await deniedContinuationFixture(content, operations);
  const checkpoint = await denied.read();
  const prepared = await prepareJudgeRecovery({
    seed: denied.request,
    requestId: "rehearsal-source-recovery",
    generation: 1,
    window: { version: "editorial-recovery-window-v1", deadlineMs: 120000 },
    content,
    archive: denied.parent.archive,
    operations,
    currentJudge: { modelVersion: "synthetic/judge" },
    parentCompletion: {
      read: async () => ({
        state: "completed",
        result: {
          version: "editorial-continuation-result-v1",
          outcome: "failed",
          reason: "editorial judgment provider-failed",
          summary: artifactRef(denied.request.parent.summary),
          draft: artifactRef(denied.request.body),
          metadata: artifactRef(denied.request.metadata),
          completedAt: denied.raw.completedAt,
        },
      }),
    },
  });
  const calls = { writer: 0, assessor: 0, judge: 0 };
  const stages = editorialStages({
    content,
    archive: denied.parent.archive,
    operations,
    writer: {
      modelVersion: "synthetic/writer",
      complete: async () => {
        calls.writer++;
        const value = JSON.parse(WRITER);
        value.title = "Retained one-revision rehearsal";
        value.responses[0].text =
          "The treaty prohibits hostile environmental modification. An editorial scope question remains.";
        return JSON.stringify(value);
      },
    },
    assessor: {
      modelVersion: "synthetic/assessor",
      complete: async () => {
        calls.assessor++;
        return "No faults found.\nEND OF ASSESSMENT";
      },
    },
    judge: {
      modelVersion: "synthetic/judge",
      complete: async () => {
        calls.judge++;
        return REVISE;
      },
    },
  });
  const loop = await runEditorialLoop({
    stages,
    policy: { version: "assess-judge-v1", maxRevisions: 1, deadlineMs: 120000 },
    draft: checkpoint.current.draft,
    initialVersion: checkpoint.current,
    initialAssessment: checkpoint.assessment,
    package: artifactRef(denied.request.package),
    sourceUrl: denied.parent.summary.input.sourceUrl,
    attemptId: "rehearsal-fixture-recovery",
    recoveryId: "rehearsal-fixture-recovery",
    priorHistory: checkpoint.history,
    revisionOffset: 1,
    initialJudgeLineage: checkpoint.lineage,
    initialJudgeRecovery: {
      capture: denied.request.capture,
      descriptorHash: checkpoint.taskDigest,
    },
    lineage: {
      intent: artifactRef(prepared.input.intent),
      parentSummary: artifactRef(denied.request.parent.summary),
    },
    now: async () => Date.now(),
    step: async (_name, work) => work(),
    progress: async () => {},
    save: async (history) =>
      writeOnce(content, `editorial-judge-recovery-loops/${hash(history)}.json`, history),
  });
  const summary = {
    version: "editorial-judge-recovery-history-v1",
    workflowKey: prepared.workflowKey,
    input: prepared.input,
    outcome: "rejected",
    approvalState: "absent",
    draft: loop.draft,
    metadata: loop.metadata,
    newCounts: { revisionAttempts: 1, revisions: 1, assessments: 1, judgments: 2 },
    editorial: loop.history,
  };
  const summaryRef = await writeOnce(
    content,
    `editorial-judge-recoveries/${hash(summary)}.json`,
    summary,
  );
  const judgment = JSON.parse(await content.read(loop.history.judgments.at(-1)!));
  const request = OwnerDraftRequestSchema.parse({
    version: "owner-draft-rehearsal-request-v1",
    requestId: "owner-rehearsal-once",
    policy: "owner-one-revision-unpublished-v1",
    findingsAcknowledged: true,
    parent: { workflowKey: prepared.workflowKey, summary: artifactReference(summaryRef) },
    body: artifactReference(loop.draft),
    metadata: artifactReference(loop.metadata),
    publication: judgment.publication,
    package: denied.request.package,
    assessment: artifactReference(loop.history.assessments.at(-1)!),
    judgment: artifactReference(loop.history.judgments.at(-1)!),
    mechanicalRun: artifactReference(loop.history.mechanicalRuns[0]!),
    destinations: ["dummy-a", "dummy-b", "substack"].map((name, i) => ({
      name,
      provider: i < 2 ? "dummy" : "substack",
      action: "draft",
      capability: "unpublished-no-email-v1",
      identity: `sha256:${String(i).repeat(64)}`,
    })),
  });
  return { request, summary, summaryRef, prepared, denied, calls, loop };
}
