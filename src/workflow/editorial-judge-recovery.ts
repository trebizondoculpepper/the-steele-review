import { isEditorialStorageFailure } from "../drafting/editorial-provider.js";
import * as restate from "@restatedev/restate-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExtractionPrompt } from "../analysis/extraction.js";
import {
  EDITORIAL_JUDGE_RECOVERY_WORKFLOW,
  JudgeRecoveryRunInputSchema,
  JudgeRecoveryWindowSchema,
  safeJudgeRecoveryReason,
  type JudgeRecoveryRunInput,
  type JudgeRecoveryResult,
  type JudgeRecoveryWindow,
} from "../content/editorial-judge-recovery-contract.js";
import type { ParsedSourceMetadata } from "../content/source-metadata.js";
import type { GitArtifactStore, ArtifactRef } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import type { RecoveryParentCompletionPort } from "../controllers/editorial-recovery-ingress.js";
import {
  EditorialRecoveryCheckpointError,
  readEditorialRecoveryCheckpoint,
} from "../drafting/editorial-recovery-checkpoint.js";
import {
  assertEditorialBaseCurrent,
  EditorialContinuationError,
} from "../drafting/editorial-continuation.js";
import { WriterRecoveryGuardError } from "../drafting/writer-attempts.js";
import { artifactRef, artifactReference, sameArtifact } from "../drafting/publication-payload.js";
import { JudgmentRecordSchema } from "../drafting/editorial-judgment.js";
import { approvedArticleEventId } from "../publishing/approved-article.js";
import { readApprovalEvidence } from "../publishing/approval-evidence.js";
import { writeOnce } from "../research/job.js";
import type { EditorialStages } from "./editorial-contract.js";
import { runEditorialLoop, EditorialLoopPersistenceError } from "./editorial-loop.js";
import {
  JudgeRecoverySubmissionError,
  judgeRecoveryIntentHash,
  recoveryArticle,
  loadJudgeRecoveryIntent,
  recordJudgeRecoveryIntent,
  requireRecoveryParent,
} from "./editorial-judge-recovery-submission.js";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const RETRY = { maxRetryAttempts: 5 } as const;
/** Exact durable approval reconciliation. Unknown never authorizes delivery of a different pair. */
export async function reconcileJudgeRecoveryApproval(input: {
  content: Pick<GitArtifactStore, "read">;
  operations: Pick<OperationStore, "operationStatus" | "pendingEvent">;
  judgment: ArtifactRef;
  version: { draft: ArtifactRef; metadata: ArtifactRef };
  package: ArtifactRef;
  post: { publicationId: string; postId: string };
}) {
  const judgment = JudgmentRecordSchema.parse(JSON.parse(await input.content.read(input.judgment)));
  if (judgment.state !== "decided" || judgment.decision !== "approve")
    return { state: "absent" as const };
  const eventId = approvedArticleEventId(artifactRef(judgment.body), input.judgment),
    status = input.operations.operationStatus(`approved:${eventId}`),
    pending = input.operations.pendingEvent(eventId);
  if (!status && !pending) return { state: "absent" as const, eventId };
  const artifact = z
    .object({ eventId: z.literal(eventId) })
    .strict()
    .safeParse(status?.artifact);
  if (status?.status !== "completed" || !artifact.success)
    return { state: "unknown" as const, eventId };
  const evidence = await readApprovalEvidence(input.content, input.judgment, "editorial-judgment");
  if (
    !sameArtifact(evidence.body, artifactReference(input.version.draft)) ||
    !evidence.payload ||
    !sameArtifact(evidence.payload.metadata, artifactReference(input.version.metadata)) ||
    !sameArtifact(evidence.package, artifactReference(input.package)) ||
    evidence.post.publicationId !== input.post.publicationId ||
    evidence.post.postId !== input.post.postId
  )
    return { state: "unknown" as const, eventId };
  return { state: "recorded" as const, eventId };
}
type Checkpoint = Awaited<ReturnType<typeof readEditorialRecoveryCheckpoint>>;
export function editorialJudgeRecoveryWorkflow(deps: {
  content: GitArtifactStore;
  archive: Pick<GitArtifactStore, "read" | "lookup">;
  operations: OperationStore;
  sourceMetadata?: ParsedSourceMetadata;
  stages: EditorialStages;
  configuredWindow: JudgeRecoveryWindow;
  currentJudge: { modelVersion: string; prompt?: ExtractionPrompt };
  parentCompletion: RecoveryParentCompletionPort;
  liveNow?: () => number;
}) {
  return restate.workflow({
    name: EDITORIAL_JUDGE_RECOVERY_WORKFLOW,
    handlers: {
      progress: restate.handlers.workflow.shared(
        async (ctx: restate.WorkflowSharedContext) =>
          (await ctx.get<Record<string, unknown>>("progress")) ?? null,
      ),
      run: async (
        ctx: restate.WorkflowContext,
        raw: JudgeRecoveryRunInput,
      ): Promise<JudgeRecoveryResult> => {
        const started = await ctx.date.now();
        const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
          const result = await ctx.run(
            name,
            async () => {
              try {
                return { kind: "value" as const, value: await work() };
              } catch (error) {
                // Domain control must survive SDK failure serialization. Storage
                // exceptions still throw here and use Restate's retry policy.
                if (error instanceof WriterRecoveryGuardError)
                  return { kind: "guard" as const, code: error.code };
                throw error;
              }
            },
            RETRY,
          );
          if (result.kind === "guard") throw new WriterRecoveryGuardError(result.code);
          return result.value;
        };
        const progress = async (phase: string, round = 0) => {
          ctx.set("progress", { phase, round, at: new Date(await ctx.date.now()).toISOString() });
        };
        let validated: JudgeRecoveryRunInput | undefined;
        const finish = async (
          value: Record<string, unknown> & {
            outcome: JudgeRecoveryResult["outcome"];
            reason?: string;
            draft?: ArtifactRef;
            metadata?: ArtifactRef;
            approvalEvent?: string;
          },
        ): Promise<JudgeRecoveryResult> => {
          const completedAt = new Date(await ctx.date.now()).toISOString();
          const reason = safeJudgeRecoveryReason(value.reason);
          const history = {
            version: "editorial-judge-recovery-history-v1",
            ...(validated
              ? { workflowKey: ctx.key, input: validated }
              : { workflowKeyHash: hash(ctx.key), invalidOrUnvalidatedInput: true }),
            ...value,
            ...(reason ? { reason } : {}),
            completedAt,
          };
          const summary = await step("judge-recovery-save-summary", () =>
            writeOnce(deps.content, `editorial-judge-recoveries/${hash(history)}.json`, history),
          );
          await progress("completed");
          return {
            version: "editorial-judge-recovery-result-v1",
            outcome: value.outcome,
            ...(reason ? { reason } : {}),
            summary,
            completedAt,
            ...(value.draft ? { draft: value.draft } : {}),
            ...(value.metadata ? { metadata: value.metadata } : {}),
            ...(value.approvalEvent ? { approvalEvent: value.approvalEvent } : {}),
          };
        };
        const parsed = JudgeRecoveryRunInputSchema.safeParse(raw);
        if (!parsed.success) return finish({ outcome: "skipped", reason: "invalid-input" });
        let checkpoint: Checkpoint, window: JudgeRecoveryWindow;
        try {
          const checked = await step("judge-recovery-validate-checkpoint", async () => {
            try {
              const intent = await loadJudgeRecoveryIntent(deps.content, parsed.data),
                article = recoveryArticle(intent.seed);
              const existing = deps.operations.editorialRecoveryAttempt(
                article.publicationId,
                article.postId,
                intent.requestId,
              );
              if (existing) {
                if (
                  existing.generation !== intent.generation ||
                  existing.inputHash !== judgeRecoveryIntentHash(intent) ||
                  existing.taskDigest !== intent.taskDigest ||
                  !sameArtifact(existing.intent, parsed.data.intent) ||
                  !sameArtifact(existing.capture, intent.seed.capture) ||
                  !sameArtifact(existing.parentSummary, intent.seed.parent.summary)
                )
                  throw new JudgeRecoverySubmissionError("identity-conflict");
              } else if (
                JSON.stringify(intent.window) !==
                JSON.stringify(JudgeRecoveryWindowSchema.parse(deps.configuredWindow))
              )
                throw new JudgeRecoverySubmissionError("window-mismatch");
              const seed = await readEditorialRecoveryCheckpoint({
                request: intent.seed,
                content: deps.content,
                archive: deps.archive,
                operations: deps.operations,
                sourceMetadata: deps.sourceMetadata,
                currentJudge: deps.currentJudge,
              });
              if (
                seed.taskDigest !== intent.taskDigest ||
                seed.originalPolicy.maxRevisions !== intent.originalEditLimit ||
                seed.originalCounts.revisionAttempts !== intent.spentEdits ||
                seed.remainingEdits !== intent.remainingEdits
              )
                throw new JudgeRecoverySubmissionError("task-mismatch");
              await requireRecoveryParent(deps.parentCompletion, intent.seed);
              const binding = recordJudgeRecoveryIntent(
                deps.operations,
                intent,
                artifactRef(parsed.data.intent),
              );
              if (binding.workflowKey !== ctx.key)
                throw new JudgeRecoverySubmissionError("identity-conflict");
              return { kind: "ready" as const, seed, window: intent.window };
            } catch (error) {
              if (
                error instanceof JudgeRecoverySubmissionError ||
                error instanceof EditorialRecoveryCheckpointError
              )
                return { kind: "stopped" as const, reason: error.code };
              if (error instanceof z.ZodError)
                return { kind: "stopped" as const, reason: "invalid-input" };
              throw error;
            }
          });
          if (checked.kind === "stopped")
            return finish({ outcome: "skipped", reason: checked.reason });
          checkpoint = checked.seed;
          window = checked.window;
          validated = parsed.data;
        } catch {
          return finish({ outcome: "failed", reason: "preflight-unavailable" });
        }
        const deadlineAt = started + window.deadlineMs;
        const deadlineGuard = async () => {
          if ((deps.liveNow ?? Date.now)() >= deadlineAt)
            throw new WriterRecoveryGuardError("deadline");
        };
        const lineage = {
          intent: artifactRef(parsed.data.intent),
          parentSummary: artifactRef(checkpoint.request.parent.summary),
        };
        const attemptId = `judge-recovery-${hash([ctx.key, parsed.data.intent]).slice(0, 32)}`;
        const shared = {
          parent: checkpoint.request.parent,
          originalIntent: checkpoint.request.intent,
          originalPolicy: checkpoint.originalPolicy,
          inheritedCounts: checkpoint.inheritedCounts,
          priorContinuationCounts: checkpoint.originalCounts,
          spentEditsBefore: checkpoint.originalCounts.revisionAttempts,
          remainingEditsBefore: checkpoint.remainingEdits,
          window,
          windowStartedAt: new Date(started).toISOString(),
          deadlineAt: new Date(deadlineAt).toISOString(),
          originalAssessment: artifactReference(checkpoint.assessment),
          originalDeniedJudgment: checkpoint.request.judgment,
          originalDeniedCapture: checkpoint.request.capture,
        };
        let result: Awaited<ReturnType<typeof runEditorialLoop>> | undefined,
          partial: EditorialLoopPersistenceError["partial"] | undefined;
        try {
          result = await runEditorialLoop({
            stages: deps.stages,
            policy: {
              version: "assess-judge-v1",
              maxRevisions: checkpoint.remainingEdits,
              deadlineMs: window.deadlineMs,
            },
            draft: checkpoint.current.draft,
            package: checkpoint.package,
            sourceUrl: checkpoint.article.sourceUrl,
            attemptId,
            recoveryId: attemptId,
            lineage,
            priorHistory: checkpoint.history,
            revisionOffset: checkpoint.originalCounts.revisionAttempts,
            initialAssessment: checkpoint.assessment,
            initialVersion: checkpoint.current,
            initialJudgeLineage: checkpoint.lineage,
            initialJudgeRecovery: {
              capture: artifactReference(checkpoint.capture),
              descriptorHash: checkpoint.taskDigest,
              beforeNewCall: async () => {
                await deadlineGuard();
                try {
                  await assertEditorialBaseCurrent(deps.content, {
                    body: artifactReference(checkpoint.current.draft),
                    metadata: artifactReference(checkpoint.current.metadata),
                  });
                } catch (error) {
                  if (error instanceof EditorialContinuationError && error.code === "stale-base")
                    throw new WriterRecoveryGuardError("stale-base");
                  throw error;
                }
              },
            },
            deadlineAt,
            beforeNewEditorialCall: deadlineGuard,
            now: () => ctx.date.now(),
            step,
            progress,
            save: (history) =>
              writeOnce(
                deps.content,
                `editorial-judge-recovery-loops/${hash([parsed.data.intent, history])}.json`,
                { ...history, lineage, parent: checkpoint.request.parent },
              ),
          });
        } catch (error) {
          if (isEditorialStorageFailure(error)) throw error;
          if (error instanceof EditorialLoopPersistenceError) partial = error.partial;
          else
            return finish({
              ...shared,
              outcome: "failed",
              reason: "editorial-stage-unavailable",
              draft: checkpoint.current.draft,
              metadata: checkpoint.current.metadata,
              newCounts: { revisionAttempts: 0, revisions: 0, assessments: 0, judgments: 0 },
              remainingEditsAfter: checkpoint.remainingEdits,
            });
        }
        const history = result?.history ?? partial!.history,
          latest = {
            draft: result?.draft ?? partial!.draft,
            metadata: result?.metadata ?? partial!.metadata,
          };
        let approvalEvent = result?.approvalEvent ?? partial?.approvalEvent,
          approvalState: "recorded" | "absent" | "unknown" = approvalEvent ? "recorded" : "absent";
        // A lost approval acknowledgment is reconciled against its exact durable event, never guessed absent.
        if (!approvalEvent && history.judgments.length) {
          try {
            const proof = await step("judge-recovery-reconcile-approval", async () => {
              return reconcileJudgeRecoveryApproval({
                content: deps.content,
                operations: deps.operations,
                judgment: history.judgments.at(-1)!,
                version: latest,
                package: checkpoint.package,
                post: checkpoint.article,
              });
            });
            approvalState = proof.state;
            if (proof.state === "recorded") approvalEvent = proof.eventId;
          } catch {
            approvalState = "unknown";
          }
        }
        const attempts = history.revisionAttempts ?? history.revisions.length;
        const outcome: JudgeRecoveryResult["outcome"] = approvalEvent
          ? "verified"
          : approvalState === "unknown" ||
              partial ||
              history.terminal === "operational-stop" ||
              history.terminal === "deadline"
            ? "failed"
            : "rejected";
        return finish({
          ...shared,
          outcome,
          reason: approvalEvent
            ? undefined
            : approvalState === "unknown"
              ? "recovery-approval-uncertain"
              : partial
                ? "recovery-summary-unavailable"
                : result!.reason,
          ...latest,
          ...(approvalEvent ? { approvalEvent } : {}),
          approvalState,
          ...(partial
            ? { partialEditorial: history, editorialSummaryUnavailable: true }
            : { editorial: history }),
          newCounts: {
            revisionAttempts: attempts,
            revisions: history.revisions.length,
            assessments: history.assessments.length - (history.reusedAssessments?.length ?? 0),
            judgments: history.judgments.length,
          },
          reusedAssessments: history.reusedAssessments ?? [],
          remainingEditsAfter: checkpoint.remainingEdits - attempts,
          totalContinuationEditAttempts: checkpoint.originalCounts.revisionAttempts + attempts,
        });
      },
    },
  });
}
export type EditorialJudgeRecoveryApi = ReturnType<typeof editorialJudgeRecoveryWorkflow>;
