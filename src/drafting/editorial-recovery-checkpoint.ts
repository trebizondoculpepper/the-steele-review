import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExtractionPrompt } from "../analysis/extraction.js";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import { JudgmentHistorySchema } from "../content/judgment-history.js";
import type { ParsedSourceMetadata } from "../content/source-metadata.js";
import { EditorialContinuationRunInputSchema } from "../content/editorial-continuation-contract.js";
import { ArtifactStoreError, type GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { approvedArticleEventId } from "../publishing/approved-article.js";
import {
  continuationIntentHash,
  loadContinuationIntent,
} from "../workflow/editorial-continuation-submission.js";
import { EditorialPolicySchema } from "../workflow/editorial-contract.js";
import { AssessmentRecordSchema, classifyFindings } from "./article-assessment.js";
import {
  assertEditorialBaseCurrent,
  EditorialContinuationError,
  readEditorialContinuationHistory,
} from "./editorial-continuation.js";
import {
  DEFAULT_JUDGE_PROMPT,
  JudgmentRecordSchema,
  readJudgmentTask,
} from "./editorial-judgment.js";
import { parseJudgmentDocument } from "./judgment-document.js";
import { PackageDraftMetadataSchema } from "./package-draft.js";
import {
  artifactRef,
  artifactReference,
  readPublicationPayload,
  sameArtifact,
} from "./publication-payload.js";
import { promptIdentity } from "./prompt-identity.js";
import { WriterAttemptManifestSchema } from "./writer-attempts.js";
const Ref = ArtifactReferenceSchema;
const Stored = Ref.omit({ hash: true })
  .extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const Version = z.object({ draft: Stored, metadata: Stored }).strict();
const Counts = z
  .object({
    assessments: z.number().int().min(0).max(6),
    judgments: z.number().int().min(0).max(6),
    revisions: z.number().int().min(0).max(5),
  })
  .strict();
const NewCounts = Counts.extend({ revisionAttempts: z.number().int().min(0).max(5) }).strict();
export const EditorialRecoveryCheckpointSchema = z
  .object({
    version: z.literal("editorial-recovery-checkpoint-v1"),
    parent: z.object({ workflowKey: z.string().min(1).max(1000), summary: Ref }).strict(),
    intent: Ref,
    body: Ref,
    metadata: Ref,
    publication: Ref,
    package: Ref,
    assessment: Ref,
    judgment: Ref,
    capture: Ref,
    input: Ref,
  })
  .strict();
export type EditorialRecoveryCheckpoint = z.infer<typeof EditorialRecoveryCheckpointSchema>;
const Loop = z
  .object({
    version: z.literal("assess-judge-v1"),
    initial: Version,
    assessments: z.array(Stored).min(1).max(6),
    judgments: z.array(Stored).min(1).max(6),
    revisions: z.array(Version).max(5),
    mechanicalRuns: z.array(Stored).max(5),
    diagnostics: z.array(Stored).max(100),
    retainedWriterAttempts: z.array(Stored).max(100),
    revisionAttempts: z.number().int().min(0).max(5),
    terminal: z.literal("operational-stop"),
    summary: Stored,
  })
  .strict();
const Summary = z
  .object({
    version: z.literal("editorial-continuation-history-v1"),
    workflowKey: z.string(),
    input: EditorialContinuationRunInputSchema,
    outcome: z.literal("failed"),
    reason: z.literal("editorial judgment provider-failed"),
    completedAt: z.iso.datetime(),
    parent: z.object({ workflowKey: z.string(), summary: Ref }).strict(),
    parentCounts: Counts,
    policy: EditorialPolicySchema,
    intent: Ref,
    source: z
      .object({
        publicationId: z.string(),
        postId: z.string(),
        sourceVersion: z.string(),
        sourceUrl: z.string(),
      })
      .strict(),
    initial: Version,
    seedEdit: Version,
    editorial: Loop,
    draft: Stored,
    metadata: Stored,
    newCounts: NewCounts,
    mechanicalRuns: z.array(Stored).max(5),
    retainedWriterAttempts: z.array(Stored).max(100),
    diagnostics: z.array(Stored).max(100),
  })
  .strict();
const Descriptor = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("judge"),
    package: Ref,
    source: Ref,
    context: z.array(Ref).max(10),
    kind: z.literal("initial"),
    number: z.literal(1),
    promptVersion: z.string(),
    requestedModel: z.string(),
    providerModel: z.string(),
    request: z
      .object({ system: z.string(), user: z.string(), maxOutputChars: z.literal(40000) })
      .strict(),
  })
  .strict();
export class EditorialRecoveryCheckpointError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "parent-mismatch"
      | "chain-mismatch"
      | "not-denied"
      | "task-mismatch"
      | "approval-present-or-uncertain"
      | "stale-base"
      | "unreadable",
  ) {
    super(`editorial recovery checkpoint: ${code}`);
    this.name = "EditorialRecoveryCheckpointError";
  }
}
const requireMatch = (value: unknown, code: EditorialRecoveryCheckpointError["code"]) => {
  if (!value) throw new EditorialRecoveryCheckpointError(code);
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (a: ArtifactReference, b: ArtifactReference) => sameArtifact(a, b);
/** No provider or write capability. Parent intent is not authoritative workflow completion. */
export async function readEditorialRecoveryCheckpoint(input: {
  request: unknown;
  content: Pick<GitArtifactStore, "read" | "lookup" | "lookupAt">;
  archive: Pick<GitArtifactStore, "read" | "lookup">;
  operations: Pick<
    OperationStore,
    "articleAttempt" | "editorialContinuationAttempt" | "operationStatus" | "pendingEvent"
  >;
  sourceMetadata?: ParsedSourceMetadata;
  currentJudge: { modelVersion: string; prompt?: ExtractionPrompt };
}) {
  const parsed = EditorialRecoveryCheckpointSchema.safeParse(input.request);
  if (!parsed.success) throw new EditorialRecoveryCheckpointError("invalid-input");
  const request = parsed.data;
  try {
    const read = async (ref: ArtifactReference) =>
      JSON.parse(await input.content.read(artifactRef(ref)));
    const raw = await read(request.parent.summary),
      summary = Summary.parse(raw);
    requireMatch(
      request.parent.summary.path === `editorial-continuations/${digest(raw)}.json` &&
        summary.workflowKey === request.parent.workflowKey,
      "parent-mismatch",
    );
    requireMatch(
      equal(summary.input.intent, request.intent) && equal(summary.intent, request.intent),
      "parent-mismatch",
    );
    const intent = await loadContinuationIntent(input.content, summary.input);
    const original = await readEditorialContinuationHistory({
      request: intent.seed,
      content: input.content,
      archive: input.archive,
      operations: input.operations,
      sourceMetadata: input.sourceMetadata,
    });
    const binding = input.operations.editorialContinuationAttempt(
      original.article.publicationId,
      original.article.postId,
      intent.requestId,
    );
    requireMatch(
      binding &&
        binding.workflowKey === summary.workflowKey &&
        binding.inputHash === continuationIntentHash(intent) &&
        equal(binding.intent, request.intent) &&
        equal(binding.parentSummary, intent.seed.parent.summary),
      "parent-mismatch",
    );
    requireMatch(
      JSON.stringify(summary.policy) === JSON.stringify(intent.policy) &&
        JSON.stringify(summary.parentCounts) === JSON.stringify(original.priorCounts) &&
        JSON.stringify(summary.source) === JSON.stringify(original.article) &&
        equal(summary.parent.summary, intent.seed.parent.summary) &&
        summary.parent.workflowKey === intent.seed.parent.workflowKey,
      "parent-mismatch",
    );
    requireMatch(
      equal(request.package, intent.seed.package) &&
        equal(artifactReference(summary.initial.draft), intent.seed.body) &&
        equal(artifactReference(summary.initial.metadata), intent.seed.metadata),
      "chain-mismatch",
    );
    const loop = summary.editorial,
      versions = [loop.initial, ...loop.revisions];
    requireMatch(
      JSON.stringify(summary.seedEdit) === JSON.stringify(loop.initial) &&
        loop.assessments.length === versions.length &&
        loop.judgments.length === versions.length &&
        loop.revisionAttempts === loop.revisions.length &&
        summary.newCounts.revisionAttempts === versions.length &&
        summary.newCounts.revisions === versions.length &&
        summary.newCounts.assessments === versions.length &&
        summary.newCounts.judgments === versions.length &&
        versions.length <= intent.policy.maxRevisions,
      "chain-mismatch",
    );
    const { summary: innerRef, ...innerHistory } = loop;
    const lineage = {
      intent: artifactRef(request.intent),
      parentSummary: artifactRef(intent.seed.parent.summary),
    };
    const inner = await read(artifactReference(innerRef));
    requireMatch(
      innerRef.path ===
        `editorial-continuation-loops/${digest([summary.input.intent, innerHistory])}.json` &&
        JSON.stringify(inner) ===
          JSON.stringify({ ...innerHistory, lineage, parentCounts: summary.parentCounts }),
      "chain-mismatch",
    );
    const last = versions.at(-1)!;
    requireMatch(
      equal(request.body, artifactReference(last.draft)) &&
        equal(request.metadata, artifactReference(last.metadata)) &&
        equal(request.body, artifactReference(summary.draft)) &&
        equal(request.metadata, artifactReference(summary.metadata)) &&
        equal(request.assessment, artifactReference(loop.assessments.at(-1)!)) &&
        equal(request.judgment, artifactReference(loop.judgments.at(-1)!)),
      "chain-mismatch",
    );
    const attempt = `editorial-continuation-${digest([summary.workflowKey, summary.input.intent]).slice(0, 32)}`;
    const history = [...original.history];
    let finalAssessment, finalJudgment;
    const originalMetadata = PackageDraftMetadataSchema.parse(await read(intent.seed.metadata));
    for (let round = 0; round < versions.length; round++) {
      const version = versions[round]!,
        assessmentRef = artifactReference(loop.assessments[round]!),
        judgmentRef = artifactReference(loop.judgments[round]!);
      const assessment = AssessmentRecordSchema.parse(await read(assessmentRef)),
        judgment = JudgmentRecordSchema.parse(await read(judgmentRef));
      const { payload } = await readPublicationPayload(input.content, assessment.publication);
      const metadata = PackageDraftMetadataSchema.parse(
        await read(artifactReference(version.metadata)),
      );
      requireMatch(
        (assessment.state === "findings" || assessment.state === "no-faults") &&
          assessment.document &&
          !assessment.operationalFailure &&
          assessment.attemptId === `${attempt}:assessment:${round}` &&
          judgment.attemptId === `${attempt}:judgment:${round}` &&
          equal(assessment.package, request.package) &&
          equal(assessment.body, artifactReference(version.draft)) &&
          equal(payload.body, assessment.body) &&
          equal(payload.metadata, artifactReference(version.metadata)) &&
          equal(judgment.assessment, assessmentRef) &&
          equal(judgment.body, assessment.body) &&
          equal(judgment.publication, assessment.publication) &&
          equal(metadata.package, request.package) &&
          metadata.contextVersion === originalMetadata.contextVersion &&
          assessment.contextVersion === metadata.contextVersion &&
          JSON.stringify(judgment.history ?? []) === JSON.stringify(history.slice(-5)),
        "chain-mismatch",
      );
      const findings = classifyFindings(
        await input.content.read(artifactRef(assessment.document!)),
      );
      requireMatch(
        findings.state === assessment.state && findings.findings === assessment.findings,
        "chain-mismatch",
      );
      if (round < versions.length - 1) {
        requireMatch(
          judgment.state === "decided" && judgment.decision === "revise" && judgment.document,
          "chain-mismatch",
        );
        const guidance = parseJudgmentDocument(
          await input.content.read(artifactRef(judgment.document!)),
        );
        requireMatch(guidance?.decision === "revise", "chain-mismatch");
        history.push({
          judgment: judgmentRef,
          assessment: assessmentRef,
          body: assessment.body,
          metadata: artifactReference(version.metadata),
        });
      }
      finalAssessment = assessment;
      finalJudgment = judgment;
    }
    const assessment = finalAssessment!,
      judgment = finalJudgment!;
    requireMatch(
      equal(request.publication, assessment.publication) &&
        judgment.state === "provider-failed" &&
        judgment.decision === "none" &&
        !judgment.document &&
        !judgment.operationalFailure &&
        judgment.gates.length === 0 &&
        judgment.retainedAttempts?.length === 1 &&
        equal(judgment.retainedAttempts[0]!, request.capture),
      "not-denied",
    );
    const manifest = WriterAttemptManifestSchema.parse(await read(request.capture));
    requireMatch(
      manifest.purpose === "judge" &&
        manifest.kind === "initial" &&
        manifest.number === 1 &&
        manifest.revision === undefined &&
        manifest.repairPromptVersion === undefined &&
        manifest.completion.stopReason === "unknown" &&
        manifest.completion.resolvedModel === undefined &&
        manifest.outcome === "no-response" &&
        manifest.failure === "unauthorised" &&
        !manifest.raw &&
        !manifest.lateResponse &&
        equal(manifest.input, request.input),
      "not-denied",
    );
    const dir = `editorial-attempts/${manifest.attemptId}`;
    requireMatch(
      request.capture.path === `${dir}/manifest.json` && request.input.path === `${dir}/input.json`,
      "not-denied",
    );
    for (const suffix of ["response.txt", "completion.json", "late-response.json", "fence.json"])
      requireMatch(!(await input.content.lookup(`${dir}/${suffix}`)), "not-denied");
    const captureState = input.operations.operationStatus(
      `editorial-capture:${manifest.attemptId}`,
    );
    const captured = z.object({ manifest: Stored }).strict().safeParse(captureState?.artifact);
    requireMatch(
      captureState?.status === "completed" &&
        captured.success &&
        equal(artifactReference(captured.data.manifest), request.capture),
      "not-denied",
    );
    const descriptor = Descriptor.parse(await read(request.input)),
      prompt = input.currentJudge.prompt ?? DEFAULT_JUDGE_PROMPT;
    const context = [
      assessment.body,
      assessment.publication,
      ...history.slice(-5).map((h) => h.judgment),
      request.intent,
      intent.seed.parent.summary,
    ];
    requireMatch(
      manifest.attemptId === `editorial-attempt-${digest(descriptor).slice(0, 32)}` &&
        equal(descriptor.package, request.package) &&
        equal(descriptor.source, assessment.source) &&
        equal(manifest.package, descriptor.package) &&
        equal(manifest.source, descriptor.source) &&
        JSON.stringify(descriptor.context) === JSON.stringify(context) &&
        JSON.stringify(manifest.context) === JSON.stringify(context) &&
        descriptor.promptVersion === prompt.version &&
        manifest.promptVersion === prompt.version &&
        descriptor.requestedModel === input.currentJudge.modelVersion &&
        descriptor.providerModel === input.currentJudge.modelVersion &&
        manifest.requestedModel === input.currentJudge.modelVersion &&
        judgment.judge?.model === input.currentJudge.modelVersion &&
        judgment.judge.promptVersion === promptIdentity(prompt.version, prompt.instructions),
      "task-mismatch",
    );
    let readFailure: unknown;
    const tracked = {
      read: async (ref: Parameters<GitArtifactStore["read"]>[0]) => {
        try {
          return await input.content.read(ref);
        } catch (error) {
          readFailure = error;
          throw error;
        }
      },
    };
    const task = await readJudgmentTask({
      content: tracked,
      assessment,
      history: JudgmentHistorySchema.parse(history.slice(-5)),
      prompt,
    });
    if (readFailure) throw readFailure;
    requireMatch(
      task.request &&
        task.gates.length === 0 &&
        JSON.stringify(task.request) === JSON.stringify(descriptor.request),
      "task-mismatch",
    );
    const eventId = approvedArticleEventId(
      artifactRef(request.body),
      artifactRef(request.judgment),
    );
    requireMatch(
      !input.operations.operationStatus(`approved:${eventId}`) &&
        !input.operations.pendingEvent(eventId),
      "approval-present-or-uncertain",
    );
    await assertEditorialBaseCurrent(input.content, {
      body: request.body,
      metadata: request.metadata,
    });
    return {
      version: request.version,
      request,
      article: original.article,
      package: artifactRef(request.package),
      current: { draft: artifactRef(request.body), metadata: artifactRef(request.metadata) },
      assessment: artifactRef(request.assessment),
      judgment: artifactRef(request.judgment),
      history: history.slice(-5),
      lineage: {
        intent: artifactRef(request.intent),
        parentSummary: artifactRef(intent.seed.parent.summary),
      },
      task: descriptor.request,
      taskDigest: digest(descriptor),
      modelVersion: input.currentJudge.modelVersion,
      promptVersion: prompt.version,
      capture: artifactRef(request.capture),
      originalPolicy: intent.policy,
      originalCounts: summary.newCounts,
      inheritedCounts: summary.parentCounts,
      remainingEdits: intent.policy.maxRevisions - summary.newCounts.revisionAttempts,
      parentCompletionRequired: {
        workflowName: "EditorialContinuation" as const,
        workflowKey: request.parent.workflowKey,
        summary: request.parent.summary,
      },
      approvalReconciledAbsent: { eventId },
    };
  } catch (error) {
    if (error instanceof EditorialRecoveryCheckpointError) throw error;
    if (error instanceof ArtifactStoreError) {
      if (["not-found", "hash-mismatch", "invalid-path"].includes(error.code))
        throw new EditorialRecoveryCheckpointError("unreadable");
      throw error;
    }
    if (error instanceof EditorialContinuationError) {
      if (error.code === "stale-base") throw new EditorialRecoveryCheckpointError("stale-base");
      throw new EditorialRecoveryCheckpointError("chain-mismatch");
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new EditorialRecoveryCheckpointError("chain-mismatch");
    throw error;
  }
}
