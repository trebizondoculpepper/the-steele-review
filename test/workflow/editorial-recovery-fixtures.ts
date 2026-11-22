import { readEditorialRecoveryCheckpoint } from "../../src/drafting/editorial-recovery-checkpoint.js";
import { createHash } from "node:crypto";
import type { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { OperationStore } from "../../src/controllers/operation-store.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import { prepareEditorialContinuation } from "../../src/workflow/editorial-continuation-submission.js";
import { editorialStages } from "../../src/workflow/editorial-stages.js";
import { runEditorialLoop } from "../../src/workflow/editorial-loop.js";
import {
  artifactRef,
  artifactReference,
  savePublicationPayload,
} from "../../src/drafting/publication-payload.js";
import { continuationParentFixture, REVISE, APPROVE } from "./editorial-continuation-fixtures.js";
import { WRITER } from "../publishing/approval-fixtures.js";
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export async function deniedContinuationFixture(
  content: GitArtifactStore,
  operations: OperationStore,
  spent = 1,
  override = false,
  metadataOnly = false,
) {
  const parent = await continuationParentFixture(content, operations);
  const policy = { version: "assess-judge-v1" as const, maxRevisions: 2, deadlineMs: 120000 };
  const prepared = await prepareEditorialContinuation({
    seed: parent.request,
    requestId: "denied-continuation",
    policy,
    content,
    archive: parent.archive,
    operations,
    parentCompletion: {
      read: async () => ({
        state: "completed",
        outcome: "rejected",
        summary: parent.request.parent.summary,
      }),
    },
  });
  const lineage = {
    intent: artifactRef(prepared.input.intent),
    parentSummary: artifactRef(parent.request.parent.summary),
  };
  const attemptId = `editorial-continuation-${hash([prepared.workflowKey, prepared.input.intent]).slice(0, 32)}`;
  const calls = { writer: 0, assessor: 0, judge: 0 };
  const stages = editorialStages({
    content,
    archive: parent.archive,
    operations,
    writer: {
      modelVersion: "synthetic/writer",
      complete: async () => {
        calls.writer++;
        const value = JSON.parse(WRITER);
        value.title = "A narrower synthetic article";
        value.responses[0].text =
          "The supplied treaty prohibits hostile environmental modification. This is a scoped account.";
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
        if (calls.judge < spent) return override ? APPROVE : REVISE;
        throw new ModelProviderError("unauthorised");
      },
    },
  });
  if (override) {
    const assess = stages.assess.bind(stages);
    stages.assess = async (...args) => {
      const result = await assess(...args);
      if (calls.assessor !== 1) return result;
      const record = JSON.parse(await content.read(result.ref));
      record.deterministicFindings = [
        {
          passage: "Synthetic scope fault",
          reason: "The retained source does not support this scope.",
        },
      ];
      return {
        ...result,
        ref: await content.write(
          `assessments/pub/p1/override-${hash(record)}.json`,
          JSON.stringify(record),
        ),
      };
    };
  }
  const edited = await stages.revise(
    { draft: artifactRef(parent.request.body), metadata: artifactRef(parent.request.metadata) },
    artifactRef(parent.request.package),
    artifactRef(parent.request.judgment),
    1,
    parent.summary.input.sourceUrl,
    attemptId,
    lineage,
  );
  if (!edited.version) throw new Error(`fixture edit failed: ${edited.failure}`);
  let selected = edited.version;
  let stageError: unknown;
  let out = await runEditorialLoop({
    stages,
    policy: { ...policy, maxRevisions: 1 },
    draft: selected.draft,
    ...(metadataOnly ? { initialVersion: selected } : {}),
    package: artifactRef(parent.request.package),
    sourceUrl: parent.summary.input.sourceUrl,
    attemptId,
    recoveryId: attemptId,
    lineage,
    priorHistory: parent.request.history,
    revisionOffset: 1,
    now: async () => Date.parse("2026-01-02T00:00:00Z"),
    step: async (_name, work) => {
      try {
        return await work();
      } catch (error) {
        stageError = error;
        throw error;
      }
    },
    progress: async () => {},
    save: async (history) =>
      content.write(
        `editorial-continuation-loops/${hash([prepared.input.intent, history])}.json`,
        JSON.stringify({
          ...history,
          lineage,
          parentCounts: { assessments: 1, judgments: 1, revisions: 0 },
        }),
      ),
  });
  if (!out.history.judgments.length)
    throw stageError ?? new Error(`fixture review stopped: ${out.reason}`);
  if (metadataOnly) {
    // Construct the already-saved complete assessment at a valid direct-body/new-metadata
    // pair. Recovery must consume this snapshot without deriving metadata from body.commit.
    const meta = JSON.parse(await content.read(out.metadata));
    meta.fields.title = "A selected metadata-only edition";
    meta.draft = `${out.draft.commit}:${out.draft.path}`;
    const metadata = await content.revise(
      out.metadata.path,
      JSON.stringify(meta),
      out.metadata.sha256,
    );
    selected = { draft: out.draft, metadata };
    const publication = await savePublicationPayload({
      content,
      body: selected.draft,
      metadata,
      post: parent.pkg.post,
    });
    const assessed = JSON.parse(await content.read(out.history.assessments[0]!));
    assessed.body = artifactReference(selected.draft);
    assessed.publication = artifactReference(publication.ref);
    const assessment = await content.write(
      `assessments/pub/p1/direct-pair-${hash(assessed)}.json`,
      JSON.stringify(assessed),
    );
    const judged = await stages.judge(
      assessment,
      `${attemptId}:judgment:0`,
      attemptId,
      parent.request.history,
      lineage,
    );
    const { summary: _summary, ...history } = out.history;
    const projected = {
      ...history,
      initial: selected,
      assessments: [assessment],
      judgments: [judged.ref],
    };
    const summary = await content.write(
      `editorial-continuation-loops/${hash([prepared.input.intent, projected])}.json`,
      JSON.stringify({
        ...projected,
        lineage,
        parentCounts: { assessments: 1, judgments: 1, revisions: 0 },
      }),
    );
    out = { ...out, draft: selected.draft, metadata, history: { ...projected, summary } };
  }
  const raw = {
    version: "editorial-continuation-history-v1",
    workflowKey: prepared.workflowKey,
    input: prepared.input,
    parent: parent.request.parent,
    parentCounts: { assessments: 1, judgments: 1, revisions: 0 },
    policy,
    intent: prepared.input.intent,
    source: {
      ...parent.pkg.post,
      sourceVersion: parent.pkg.source.sourceVersion,
      sourceUrl: parent.summary.input.sourceUrl,
    },
    outcome: "failed",
    reason: "editorial judgment provider-failed",
    initial: {
      draft: artifactRef(parent.request.body),
      metadata: artifactRef(parent.request.metadata),
    },
    seedEdit: selected,
    editorial: out.history,
    draft: out.draft,
    metadata: out.metadata,
    newCounts: { revisionAttempts: spent, revisions: spent, assessments: spent, judgments: spent },
    mechanicalRuns: [edited.mechanicalRun!, ...out.history.mechanicalRuns],
    retainedWriterAttempts: [
      ...(edited.retainedAttempts ?? []),
      ...(out.history.retainedWriterAttempts ?? []),
    ],
    diagnostics: [],
    completedAt: "2026-01-02T00:00:01.000Z",
  };
  const summary = await content.write(
    `editorial-continuations/${hash(raw)}.json`,
    JSON.stringify(raw),
  );
  const judgmentRef = out.history.judgments.at(-1)!,
    judgment = JSON.parse(await content.read(judgmentRef));
  const capture = judgment.retainedAttempts[0],
    manifest = JSON.parse(await content.read(artifactRef(capture)));
  const request = {
    version: "editorial-recovery-checkpoint-v1",
    parent: { workflowKey: prepared.workflowKey, summary: artifactReference(summary) },
    intent: prepared.input.intent,
    body: artifactReference(out.draft),
    metadata: artifactReference(out.metadata),
    publication: judgment.publication,
    package: parent.request.package,
    assessment: judgment.assessment,
    judgment: artifactReference(judgmentRef),
    capture,
    input: manifest.input,
  };
  const read = (overrides: Partial<Parameters<typeof readEditorialRecoveryCheckpoint>[0]> = {}) =>
    readEditorialRecoveryCheckpoint({
      request,
      content,
      archive: parent.archive,
      operations,
      currentJudge: { modelVersion: "synthetic/judge" },
      ...overrides,
    });
  return { parent, prepared, calls, request, raw, manifest, judgment, read };
}
