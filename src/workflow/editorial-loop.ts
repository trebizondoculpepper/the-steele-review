import type { EditorialPolicyObservation } from "../config/editorial-live-policy.js";
import { isEditorialStorageFailure } from "../drafting/editorial-provider.js";
import {
  WriterRecoveryGuardError,
  WriterAttemptError,
  type ExpectedWriterRecovery,
} from "../drafting/writer-attempts.js";
import type { EditorialLineage } from "../content/editorial-lineage.js";
import type { JudgmentHistory } from "../content/judgment-history.js";
import type { EditorialHistory, EditorialPolicy, EditorialStages } from "./editorial-contract.js";
import type { Ref } from "./article-run.js";

/** Preserve known completed work if only its final history save is unavailable. */
export class EditorialLoopPersistenceError extends Error {
  constructor(
    readonly partial: {
      draft: Ref;
      metadata: Ref;
      history: Omit<EditorialHistory, "summary">;
      reason: string;
      approvalEvent?: string;
    },
  ) {
    super("editorial loop summary unavailable");
  }
}

/** Journal ports supplied by Restate; there is no second scheduler or retry loop here. */
export async function runEditorialLoop(input: {
  stages: EditorialStages;
  policy: EditorialPolicy;
  /** Only a serialized new workflow contract supplies these ports. */
  livePolicy?: {
    read(): Promise<EditorialPolicyObservation>;
    authorize(input: {
      version: { draft: Ref; metadata: Ref };
      assessment: Ref;
      judgment: Ref;
      assessments: Ref[];
      judgments: Ref[];
      revisions: { draft: Ref; metadata: Ref }[];
      mechanicalRuns: Ref[];
      policy: EditorialPolicyObservation;
    }): Promise<{ eventId: string }>;
  };
  draft: Ref;
  package: Ref;
  sourceUrl: string;
  attemptId: string;
  recoveryId?: string;
  lineage?: EditorialLineage;
  /** Only a separately versioned workflow may opt into judging a validated saved assessment first. */
  initialAssessment?: Ref;
  /** Exact validated pair for the separately versioned recovery contract; legacy callers still prepare normally. */
  initialVersion?: { draft: Ref; metadata: Ref };
  initialJudgeLineage?: EditorialLineage;
  initialJudgeRecovery?: ExpectedWriterRecovery;
  beforeNewEditorialCall?: () => Promise<void>;
  priorHistory?: JudgmentHistory;
  revisionOffset?: number;
  deadlineAt?: number;
  now(): Promise<number>;
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
  progress(
    phase: "prepare" | "assess" | "judge" | "revise" | "approve",
    round: number,
  ): Promise<void>;
  save(history: Omit<EditorialHistory, "summary">): Promise<Ref>;
}) {
  const startedAt = input.deadlineAt !== undefined && !input.livePolicy ? 0 : await input.now();
  let deadline = input.deadlineAt ?? startedAt + input.policy.deadlineMs;
  const policyObservations: EditorialPolicyObservation[] = [];
  let policy = input.policy;
  let appliedPolicy: EditorialPolicyObservation | undefined;
  let draftAuthorizationEvent: string | undefined;
  const observe = async (phase: string, round: number) => {
    if (!input.livePolicy) return;
    appliedPolicy = await input.step(`editorial-policy-${phase}-${round}`, input.livePolicy.read);
    policyObservations.push(appliedPolicy);
    policy = appliedPolicy.policy;
    deadline = startedAt + policy.deadlineMs;
  };
  let version =
    input.initialVersion ??
    (await input.step("editorial-prepare", () => input.stages.prepare(input.draft, input.package)));
  const initial = version;
  const judgmentHistory: JudgmentHistory = [...(input.priorHistory ?? [])];
  const reference = (r: Ref) => ({
    repository: r.repository,
    commit: r.commit,
    path: r.path,
    hash: `sha256:${r.sha256}`,
  });
  const assessments: Ref[] = [],
    judgments: Ref[] = [],
    revisions: (typeof version)[] = [],
    mechanicalRuns: Ref[] = [],
    diagnostics: Ref[] = [],
    retainedWriterAttempts: Ref[] = [];
  let terminal: EditorialHistory["terminal"] = "unresolved",
    reason = "editorial revision limit reached",
    approvalEvent: string | undefined;
  const expired = async () => (await input.now()) >= deadline;
  let revisionAttempts = 0;
  const retainedControlArtifacts: Ref[] = [];
  const reusedAssessments: Ref[] = [];
  try {
    for (let round = 0; round <= (input.livePolicy ? 5 : input.policy.maxRevisions); round++) {
      await observe("assess", round);
      if (await expired()) {
        terminal = "deadline";
        reason = "editorial deadline reached";
        break;
      }
      let assessment: Awaited<ReturnType<EditorialStages["assess"]>>;
      if (round === 0 && input.initialAssessment) {
        assessment = { ref: input.initialAssessment, state: "reused-complete" };
        reusedAssessments.push(input.initialAssessment);
      } else {
        await input.progress("assess", round);
        assessment = await input.step(`editorial-assess-${round}`, () =>
          input.stages.assess(
            version,
            input.package,
            `${input.attemptId}:assessment:${round}`,
            input.recoveryId,
            input.lineage,
            ...(input.beforeNewEditorialCall ? [input.beforeNewEditorialCall] : []),
          ),
        );
      }
      assessments.push(assessment.ref);
      if (assessment.operationalFailure) {
        terminal = "operational-stop";
        reason = `assessment: ${assessment.operationalFailure}`;
        break;
      }
      if (await expired()) {
        terminal = "deadline";
        reason = "editorial deadline reached";
        break;
      }
      await observe("judge", round);
      if (await expired()) {
        terminal = "deadline";
        reason = "editorial deadline reached";
        break;
      }
      await input.progress("judge", round);
      const judgeArgs = [
        assessment.ref,
        `${input.attemptId}:judgment:${round}`,
        input.recoveryId,
        judgmentHistory.slice(-5),
        round === 0 ? (input.initialJudgeLineage ?? input.lineage) : input.lineage,
      ] as const;
      const judgment = await input.step(`editorial-judge-${round}`, () =>
        (round === 0 && input.initialJudgeRecovery) || input.beforeNewEditorialCall
          ? input.stages.judge(
              ...judgeArgs,
              round === 0 ? input.initialJudgeRecovery : undefined,
              input.beforeNewEditorialCall,
            )
          : input.stages.judge(...judgeArgs),
      );
      judgments.push(judgment.ref);
      judgmentHistory.push({
        judgment: reference(judgment.ref),
        assessment: reference(assessment.ref),
        body: reference(version.draft),
        metadata: reference(version.metadata),
      });
      if (judgment.operationalFailure) {
        terminal = "operational-stop";
        reason = `judgment: ${judgment.operationalFailure}`;
        break;
      }
      if (await expired()) {
        terminal = "deadline";
        reason = "editorial deadline reached";
        break;
      }
      if (judgment.state !== "decided" || judgment.decision === "none") {
        terminal = "operational-stop";
        reason = `editorial judgment ${judgment.state}`;
        break;
      }
      await observe("decision", round);
      if (await expired()) {
        terminal = "deadline";
        reason = "editorial deadline reached";
        break;
      }
      const exhausted = round >= policy.maxRevisions;
      if (
        input.livePolicy &&
        policy.onExhausted === "create-unpublished-draft" &&
        (judgment.decision === "approve" || exhausted)
      ) {
        const authorized = await input.step("editorial-authorize-draft", () =>
          input.livePolicy!.authorize({
            version,
            assessment: assessment.ref,
            judgment: judgment.ref,
            assessments,
            judgments,
            revisions,
            mechanicalRuns,
            policy: appliedPolicy!,
          }),
        );
        draftAuthorizationEvent = authorized.eventId;
        terminal = judgment.decision === "approve" ? "approved" : "unresolved";
        reason = judgment.decision === "approve" ? "" : "editorial revision limit reached";
        break;
      }
      if (judgment.decision === "approve") {
        await input.progress("approve", round);
        const approval = await input.step("editorial-record-approval", () =>
          input.stages.approve(judgment.ref),
        );
        approvalEvent = approval.eventId;
        terminal = "approved";
        reason = "";
        break;
      }
      if (exhausted) break;
      await input.progress("revise", round + 1);
      revisionAttempts++;
      const revised = await input.step(`editorial-revise-${round + 1}`, () =>
        input.stages.revise(
          version,
          input.package,
          judgment.ref,
          round + 1 + (input.revisionOffset ?? 0),
          input.sourceUrl,
          input.recoveryId,
          input.lineage,
          ...(input.beforeNewEditorialCall ? [input.beforeNewEditorialCall] : []),
        ),
      );
      if (revised.mechanicalRun) mechanicalRuns.push(revised.mechanicalRun);
      if (input.lineage) retainedWriterAttempts.push(...(revised.retainedAttempts ?? []));
      diagnostics.push(...(revised.diagnostics ?? []));
      if (!revised.version) {
        terminal = "operational-stop";
        reason = revised.failure ?? "editorial writer failed";
        break;
      }
      version = revised.version;
      revisions.push(version);
    }
  } catch (error) {
    if (
      input.livePolicy ||
      !input.lineage ||
      (input.initialAssessment && isEditorialStorageFailure(error))
    )
      throw error;
    terminal = "operational-stop";
    reason =
      input.initialAssessment && error instanceof WriterRecoveryGuardError
        ? `recovery-${error.code}`
        : "editorial-stage-unavailable";
    if (input.initialAssessment && error instanceof WriterAttemptError && error.artifact)
      retainedControlArtifacts.push(error.artifact);
  }
  const history = {
    version: input.policy.version,
    initial,
    assessments,
    judgments,
    revisions,
    mechanicalRuns,
    diagnostics,
    ...(input.lineage ? { retainedWriterAttempts, revisionAttempts } : {}),
    ...(input.initialAssessment ? { reusedAssessments, retainedControlArtifacts } : {}),
    ...(input.livePolicy
      ? { policyObservations, ...(draftAuthorizationEvent ? { draftAuthorizationEvent } : {}) }
      : {}),
    terminal,
  };
  let summary: Ref;
  try {
    summary = await input.step("editorial-save-summary", () => input.save(history));
  } catch (error) {
    if (!input.lineage) throw error;
    throw new EditorialLoopPersistenceError({
      draft: version.draft,
      metadata: version.metadata,
      history,
      reason,
      ...(approvalEvent ? { approvalEvent } : {}),
    });
  }
  return {
    draft: version.draft,
    metadata: version.metadata,
    history: { ...history, summary },
    reason,
    approvalEvent,
    ...(draftAuthorizationEvent ? { draftAuthorizationEvent } : {}),
  };
}
