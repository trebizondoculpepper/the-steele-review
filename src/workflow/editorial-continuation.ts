import * as restate from "@restatedev/restate-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EDITORIAL_CONTINUATION_WORKFLOW,
  EditorialContinuationRunInputSchema,
  type EditorialContinuationRunInput,
  safeContinuationReason,
} from "../content/editorial-continuation-contract.js";
import { artifactRef } from "../drafting/publication-payload.js";
import {
  readEditorialContinuation,
  type ValidatedEditorialContinuation,
} from "../drafting/editorial-continuation.js";
import type { GitArtifactStore, ArtifactRef } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  EditorialIngressError,
  type ParentCompletionPort,
} from "../controllers/editorial-continuation-ingress.js";
import type { ParsedSourceMetadata } from "../content/source-metadata.js";
import type { EditorialLineage } from "../content/editorial-lineage.js";
import {
  EditorialPolicySchema,
  sameEditorialPolicy,
  type EditorialPolicy,
  type EditorialStages,
} from "./editorial-contract.js";
import { runEditorialLoop, EditorialLoopPersistenceError } from "./editorial-loop.js";
import {
  continuationDomainCode,
  continuationArticle,
  continuationIntentHash,
  ContinuationSubmissionError,
  loadContinuationIntent,
  recordContinuationIntent,
  requireParentCompletion,
} from "./editorial-continuation-submission.js";
import { writeOnce } from "../research/job.js";
const STEP_RETRY = { maxRetryAttempts: 5 } as const;
export interface EditorialContinuationResult {
  version: "editorial-continuation-result-v1";
  outcome: "verified" | "rejected" | "skipped" | "failed";
  reason?: string;
  summary: ArtifactRef;
  completedAt: string;
  draft?: ArtifactRef;
  metadata?: ArtifactRef;
  approvalEvent?: string;
}
/** Separate workflow and serialized input; no branch is added to historical ArticleRun journals. */
export function editorialContinuationWorkflow(deps: {
  content: GitArtifactStore;
  archive: Pick<GitArtifactStore, "read" | "lookup">;
  operations: OperationStore;
  sourceMetadata?: ParsedSourceMetadata;
  stages: EditorialStages;
  configuredPolicy: EditorialPolicy;
  parentCompletion: ParentCompletionPort;
}) {
  return restate.workflow({
    name: EDITORIAL_CONTINUATION_WORKFLOW,
    handlers: {
      progress: restate.handlers.workflow.shared(
        async (ctx: restate.WorkflowSharedContext) =>
          (await ctx.get<Record<string, unknown>>("progress")) ?? null,
      ),
      run: async (
        ctx: restate.WorkflowContext,
        raw: EditorialContinuationRunInput,
      ): Promise<EditorialContinuationResult> => {
        const now = () => ctx.date.now(),
          started = await now();
        const step = <T>(name: string, work: () => Promise<T>) => ctx.run(name, work, STEP_RETRY);
        const progress = async (phase: string, round = 0) => {
          ctx.set("progress", { phase, round, at: new Date(await now()).toISOString() });
        };
        let validatedInput: EditorialContinuationRunInput | undefined;
        const finish = async (
          value: Record<string, unknown> & {
            outcome: EditorialContinuationResult["outcome"];
            reason?: string;
            draft?: ArtifactRef;
            metadata?: ArtifactRef;
            approvalEvent?: string;
          },
        ): Promise<EditorialContinuationResult> => {
          value = {
            ...value,
            ...(value.reason ? { reason: safeContinuationReason(value.reason) } : {}),
          };
          const completedAt = new Date(await now()).toISOString(),
            history = {
              version: "editorial-continuation-history-v1",
              ...(validatedInput
                ? { workflowKey: ctx.key, input: validatedInput }
                : {
                    workflowKeyHash: createHash("sha256").update(ctx.key).digest("hex"),
                    invalidOrUnvalidatedInput: true,
                  }),
              ...value,
              completedAt,
            };
          const key = createHash("sha256").update(JSON.stringify(history)).digest("hex");
          const summary = await step("continuation-save-summary", () =>
            writeOnce(deps.content, `editorial-continuations/${key}.json`, history),
          );
          await progress("completed");
          return {
            version: "editorial-continuation-result-v1",
            outcome: value.outcome,
            ...(value.reason ? { reason: value.reason } : {}),
            summary,
            completedAt,
            ...(value.draft ? { draft: value.draft } : {}),
            ...(value.metadata ? { metadata: value.metadata } : {}),
            ...(value.approvalEvent ? { approvalEvent: value.approvalEvent } : {}),
          };
        };
        const parsed = EditorialContinuationRunInputSchema.safeParse(raw);
        if (!parsed.success) return finish({ outcome: "skipped", reason: "invalid-input" });
        await progress("validate");
        let seed: ValidatedEditorialContinuation, policy: EditorialPolicy;
        try {
          const checked = await step("continuation-validate-parent-seed", async () => {
            try {
              const intent = await loadContinuationIntent(deps.content, parsed.data);
              const configured = EditorialPolicySchema.parse(deps.configuredPolicy);
              const article = continuationArticle(intent.seed);
              const existing = deps.operations.editorialContinuationAttempt(
                article.publicationId,
                article.postId,
                intent.requestId,
              );
              if (existing) {
                if (
                  existing.inputHash !== continuationIntentHash(intent) ||
                  JSON.stringify(existing.intent) !== JSON.stringify(parsed.data.intent) ||
                  JSON.stringify(existing.parentSummary) !==
                    JSON.stringify(intent.seed.parent.summary)
                )
                  throw new ContinuationSubmissionError("identity-conflict");
              } else if (!sameEditorialPolicy(intent.policy, configured))
                throw new ContinuationSubmissionError("policy-mismatch");
              const seed = await readEditorialContinuation({ ...deps, request: intent.seed });
              await requireParentCompletion(deps.parentCompletion, intent.seed);
              const binding = recordContinuationIntent(
                deps.operations,
                intent,
                parsed.data.intent,
                seed.article.sourceVersion,
              );
              if (binding.workflowKey !== ctx.key)
                throw new ContinuationSubmissionError("identity-conflict");
              return { kind: "valid" as const, seed, policy: intent.policy };
            } catch (error) {
              const reason =
                continuationDomainCode(error) ??
                (error instanceof EditorialIngressError && error.code === "unconfigured"
                  ? "completion-unconfigured"
                  : undefined);
              if (reason || error instanceof z.ZodError)
                return { kind: "stopped" as const, reason: reason ?? "invalid-input" };
              throw error;
            }
          });
          if (checked.kind === "stopped")
            return finish({ outcome: "skipped", reason: checked.reason });
          seed = checked.seed;
          policy = checked.policy;
          validatedInput = parsed.data;
        } catch {
          return finish({ outcome: "failed", reason: "preflight-unavailable" });
        }
        const deadlineAt = started + policy.deadlineMs;
        const lineage: EditorialLineage = {
          intent: artifactRef(parsed.data.intent),
          parentSummary: artifactRef(seed.request.parent.summary),
        };
        const attemptId = `editorial-continuation-${createHash("sha256")
          .update(JSON.stringify([ctx.key, parsed.data.intent]))
          .digest("hex")
          .slice(0, 32)}`;
        const shared = {
          parent: seed.request.parent,
          parentCounts: seed.priorCounts,
          policy,
          intent: parsed.data.intent,
          source: seed.article,
        };
        if ((await now()) >= deadlineAt)
          return finish({
            ...shared,
            outcome: "failed",
            reason: "editorial-deadline",
            newCounts: { revisionAttempts: 0, revisions: 0, assessments: 0, judgments: 0 },
            mechanicalRuns: [],
          });
        await progress("revise", 1);
        let edited: Awaited<ReturnType<EditorialStages["revise"]>>;
        try {
          edited = await step("continuation-seed-revise-1", async () => {
            const out = await deps.stages.revise(
              seed.initial,
              seed.package,
              seed.judgment,
              1,
              seed.article.sourceUrl,
              attemptId,
              lineage,
            );
            if (out.failure === "writer-archive-failed" || out.failure === "writer-attempt-busy")
              throw new Error("continuation revision storage unavailable");
            return out;
          });
        } catch {
          return finish({
            ...shared,
            outcome: "failed",
            reason: "revision-unavailable",
            newCounts: { revisionAttempts: 1, revisions: 0, assessments: 0, judgments: 0 },
            mechanicalRuns: [],
          });
        }
        const seedRuns = edited.mechanicalRun ? [edited.mechanicalRun] : [],
          seedRetained = edited.retainedAttempts ?? [];
        if (!edited.version)
          return finish({
            ...shared,
            outcome: "failed",
            reason: edited.failure ?? "revision-failed",
            initial: seed.initial,
            newCounts: { revisionAttempts: 1, revisions: 0, assessments: 0, judgments: 0 },
            mechanicalRuns: seedRuns,
            retainedWriterAttempts: seedRetained,
            diagnostics: edited.diagnostics ?? [],
          });
        try {
          const out = await runEditorialLoop({
            stages: deps.stages,
            policy: { ...policy, maxRevisions: policy.maxRevisions - 1 },
            draft: edited.version.draft,
            package: seed.package,
            sourceUrl: seed.article.sourceUrl,
            attemptId,
            recoveryId: attemptId,
            lineage,
            priorHistory: seed.history,
            revisionOffset: 1,
            deadlineAt,
            now,
            step,
            progress: (phase, round) => progress(phase, round + 1),
            save: (history) =>
              writeOnce(
                deps.content,
                `editorial-continuation-loops/${createHash("sha256")
                  .update(JSON.stringify([parsed.data.intent, history]))
                  .digest("hex")}.json`,
                { ...history, lineage, parentCounts: seed.priorCounts },
              ),
          });
          return finish({
            ...shared,
            outcome:
              out.history.terminal === "approved"
                ? "verified"
                : out.history.terminal === "unresolved"
                  ? "rejected"
                  : "failed",
            reason: out.reason,
            initial: seed.initial,
            seedEdit: edited.version,
            editorial: out.history,
            draft: out.draft,
            metadata: out.metadata,
            ...(out.approvalEvent ? { approvalEvent: out.approvalEvent } : {}),
            newCounts: {
              revisionAttempts:
                1 + (out.history.revisionAttempts ?? out.history.mechanicalRuns.length),
              revisions: 1 + out.history.revisions.length,
              assessments: out.history.assessments.length,
              judgments: out.history.judgments.length,
            },
            mechanicalRuns: [...seedRuns, ...out.history.mechanicalRuns],
            retainedWriterAttempts: [
              ...seedRetained,
              ...(out.history.retainedWriterAttempts ?? []),
            ],
            diagnostics: [...(edited.diagnostics ?? []), ...out.history.diagnostics],
          });
        } catch (error) {
          if (error instanceof EditorialLoopPersistenceError) {
            const p = error.partial;
            return finish({
              ...shared,
              outcome: "failed",
              reason: "editorial-summary-unavailable",
              initial: seed.initial,
              seedEdit: edited.version,
              draft: p.draft,
              metadata: p.metadata,
              ...(p.approvalEvent ? { approvalEvent: p.approvalEvent } : {}),
              editorialSummaryUnavailable: true,
              partialEditorial: p.history,
              newCounts: {
                revisionAttempts:
                  1 + (p.history.revisionAttempts ?? p.history.mechanicalRuns.length),
                revisions: 1 + p.history.revisions.length,
                assessments: p.history.assessments.length,
                judgments: p.history.judgments.length,
              },
              mechanicalRuns: [...seedRuns, ...p.history.mechanicalRuns],
              retainedWriterAttempts: [
                ...seedRetained,
                ...(p.history.retainedWriterAttempts ?? []),
              ],
              diagnostics: [...(edited.diagnostics ?? []), ...p.history.diagnostics],
            });
          }
          return finish({
            ...shared,
            outcome: "failed",
            reason: "editorial-stage-unavailable",
            initial: seed.initial,
            seedEdit: edited.version,
            draft: edited.version.draft,
            metadata: edited.version.metadata,
            newCounts: { revisionAttempts: 1, revisions: 1, assessments: 0, judgments: 0 },
            mechanicalRuns: seedRuns,
            retainedWriterAttempts: seedRetained,
          });
        }
      },
    },
  });
}
export type EditorialContinuationApi = ReturnType<typeof editorialContinuationWorkflow>;
