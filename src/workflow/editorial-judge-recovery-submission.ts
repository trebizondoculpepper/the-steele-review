import { createHash } from "node:crypto";
import type { ExtractionPrompt } from "../analysis/extraction.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import type { ParsedSourceMetadata } from "../content/source-metadata.js";
import {
  JudgeRecoveryIntentSchema,
  JudgeRecoveryRunInputSchema,
  type JudgeRecoveryIntent,
  type JudgeRecoveryRunInput,
  type JudgeRecoveryWindow,
} from "../content/editorial-judge-recovery-contract.js";
import {
  EditorialRecoveryCheckpointSchema,
  readEditorialRecoveryCheckpoint,
} from "../drafting/editorial-recovery-checkpoint.js";
import { classifyArticlePath } from "../drafting/article-identity.js";
import { artifactRef, artifactReference, sameArtifact } from "../drafting/publication-payload.js";
import { writeOnce } from "../research/job.js";
import type { RecoveryParentCompletionPort } from "../controllers/editorial-recovery-ingress.js";
export class JudgeRecoverySubmissionError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "identity-conflict"
      | "parent-not-complete"
      | "parent-result-mismatch"
      | "window-mismatch"
      | "task-mismatch",
  ) {
    super(`editorial judge recovery: ${code}`);
    this.name = "JudgeRecoverySubmissionError";
  }
}
export const judgeRecoveryIntentHash = (value: JudgeRecoveryIntent) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function recoveryArticle(seed: { body: { path: string } }) {
  const article = classifyArticlePath(seed.body.path);
  if (!article || article.kind !== "canonical" || article.part !== "body")
    throw new JudgeRecoverySubmissionError("invalid-input");
  return { publicationId: article.publicationId, postId: article.postId };
}
export async function loadJudgeRecoveryIntent(
  content: Pick<GitArtifactStore, "read">,
  run: JudgeRecoveryRunInput,
) {
  const intent = JudgeRecoveryIntentSchema.parse(
    JSON.parse(await content.read(artifactRef(run.intent))),
  );
  const article = recoveryArticle(intent.seed);
  if (
    intent.requestId !== run.requestId ||
    intent.generation !== run.generation ||
    run.intent.path !==
      `editorial-judge-recovery-intents/${article.publicationId}/${article.postId}/${judgeRecoveryIntentHash(intent)}.json`
  )
    throw new JudgeRecoverySubmissionError("identity-conflict");
  return intent;
}
export async function requireRecoveryParent(
  port: RecoveryParentCompletionPort,
  seed: JudgeRecoveryIntent["seed"],
) {
  const parent = await port.read(seed.parent.workflowKey);
  if (parent.state !== "completed") throw new JudgeRecoverySubmissionError("parent-not-complete");
  const result = parent.result;
  if (
    result.outcome !== "failed" ||
    result.reason !== "editorial judgment provider-failed" ||
    !sameArtifact(artifactReference(result.summary), seed.parent.summary) ||
    !result.draft ||
    !result.metadata ||
    !sameArtifact(artifactReference(result.draft), seed.body) ||
    !sameArtifact(artifactReference(result.metadata), seed.metadata) ||
    result.approvalEvent
  )
    throw new JudgeRecoverySubmissionError("parent-result-mismatch");
}
export function recordJudgeRecoveryIntent(
  operations: Pick<OperationStore, "recordEditorialRecovery">,
  intent: JudgeRecoveryIntent,
  ref: ArtifactRef,
) {
  return operations.recordEditorialRecovery({
    ...recoveryArticle(intent.seed),
    requestId: intent.requestId,
    generation: intent.generation,
    capture: intent.seed.capture,
    taskDigest: intent.taskDigest,
    inputHash: judgeRecoveryIntentHash(intent),
    intent: artifactReference(ref),
    parentSummary: intent.seed.parent.summary,
  });
}
export async function prepareJudgeRecovery(input: {
  seed: unknown;
  requestId: string;
  generation: number;
  window: JudgeRecoveryWindow;
  content: GitArtifactStore;
  archive: Pick<GitArtifactStore, "read" | "lookup">;
  operations: Pick<
    OperationStore,
    | "articleAttempt"
    | "editorialContinuationAttempt"
    | "operationStatus"
    | "pendingEvent"
    | "editorialRecoveryAttempt"
    | "recordEditorialRecovery"
  >;
  sourceMetadata?: ParsedSourceMetadata;
  currentJudge: { modelVersion: string; prompt?: ExtractionPrompt };
  parentCompletion: RecoveryParentCompletionPort;
}) {
  const parsed = EditorialRecoveryCheckpointSchema.safeParse(input.seed);
  if (!parsed.success) throw new JudgeRecoverySubmissionError("invalid-input");
  const seed = parsed.data,
    article = recoveryArticle(seed);
  const previous = input.operations.editorialRecoveryAttempt(
    article.publicationId,
    article.postId,
    input.requestId,
  );
  if (previous) {
    const run = JudgeRecoveryRunInputSchema.parse({
      version: "editorial-judge-recovery-run-v1",
      requestId: input.requestId,
      generation: input.generation,
      intent: previous.intent,
    });
    const intent = await loadJudgeRecoveryIntent(input.content, run);
    if (
      previous.generation !== input.generation ||
      previous.inputHash !== judgeRecoveryIntentHash(intent) ||
      previous.taskDigest !== intent.taskDigest ||
      !sameArtifact(previous.capture, seed.capture) ||
      !sameArtifact(previous.parentSummary, seed.parent.summary) ||
      JSON.stringify(seed) !== JSON.stringify(intent.seed)
    )
      throw new JudgeRecoverySubmissionError("identity-conflict");
    return { input: run, intent, workflowKey: previous.workflowKey, repeatedIntent: true };
  }
  const checkpoint = await readEditorialRecoveryCheckpoint({
    request: seed,
    content: input.content,
    archive: input.archive,
    operations: input.operations,
    sourceMetadata: input.sourceMetadata,
    currentJudge: input.currentJudge,
  });
  await requireRecoveryParent(input.parentCompletion, seed);
  const intent = JudgeRecoveryIntentSchema.parse({
    version: "editorial-judge-recovery-intent-v1",
    requestId: input.requestId,
    generation: input.generation,
    seed,
    window: input.window,
    taskDigest: checkpoint.taskDigest,
    originalEditLimit: checkpoint.originalPolicy.maxRevisions,
    spentEdits: checkpoint.originalCounts.revisionAttempts,
    remainingEdits: checkpoint.remainingEdits,
  });
  const ref = await writeOnce(
    input.content,
    `editorial-judge-recovery-intents/${article.publicationId}/${article.postId}/${judgeRecoveryIntentHash(intent)}.json`,
    intent,
  );
  const run = JudgeRecoveryRunInputSchema.parse({
    version: "editorial-judge-recovery-run-v1",
    requestId: intent.requestId,
    generation: intent.generation,
    intent: artifactReference(ref),
  });
  const bound = await loadJudgeRecoveryIntent(input.content, run);
  const binding = recordJudgeRecoveryIntent(input.operations, bound, ref);
  return { input: run, intent: bound, workflowKey: binding.workflowKey, repeatedIntent: false };
}
