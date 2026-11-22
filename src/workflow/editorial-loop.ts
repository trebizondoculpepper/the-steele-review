import type { EditorialHistory, EditorialPolicy, EditorialStages } from "./editorial-contract.js";
import type { Ref } from "./article-run.js";

/** Journal ports supplied by Restate; there is no second scheduler or retry loop here. */
export async function runEditorialLoop(input: {
  stages: EditorialStages;
  policy: EditorialPolicy;
  draft: Ref;
  package: Ref;
  sourceUrl: string;
  attemptId: string;
  recoveryId?: string;
  now(): Promise<number>;
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
  progress(
    phase: "prepare" | "assess" | "judge" | "revise" | "approve",
    round: number,
  ): Promise<void>;
  save(history: Omit<EditorialHistory, "summary">): Promise<Ref>;
}) {
  const deadline = (await input.now()) + input.policy.deadlineMs;
  let version = await input.step("editorial-prepare", () =>
    input.stages.prepare(input.draft, input.package),
  );
  const initial = version;
  const assessments: Ref[] = [],
    judgments: Ref[] = [],
    revisions: (typeof version)[] = [],
    mechanicalRuns: Ref[] = [],
    diagnostics: Ref[] = [];
  let terminal: EditorialHistory["terminal"] = "unresolved",
    reason = "editorial revision limit reached",
    approvalEvent: string | undefined;
  const expired = async () => (await input.now()) >= deadline;
  for (let round = 0; round <= input.policy.maxRevisions; round++) {
    if (await expired()) {
      terminal = "deadline";
      reason = "editorial deadline reached";
      break;
    }
    await input.progress("assess", round);
    const assessment = await input.step(`editorial-assess-${round}`, () =>
      input.stages.assess(
        version,
        input.package,
        `${input.attemptId}:assessment:${round}`,
        input.recoveryId,
      ),
    );
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
    await input.progress("judge", round);
    const judgment = await input.step(`editorial-judge-${round}`, () =>
      input.stages.judge(assessment.ref, `${input.attemptId}:judgment:${round}`, input.recoveryId),
    );
    judgments.push(judgment.ref);
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
    if (round === input.policy.maxRevisions) break;
    await input.progress("revise", round + 1);
    const revised = await input.step(`editorial-revise-${round + 1}`, () =>
      input.stages.revise(
        version,
        input.package,
        judgment.ref,
        round + 1,
        input.sourceUrl,
        input.recoveryId,
      ),
    );
    if (revised.mechanicalRun) mechanicalRuns.push(revised.mechanicalRun);
    diagnostics.push(...(revised.diagnostics ?? []));
    if (!revised.version) {
      terminal = "operational-stop";
      reason = revised.failure ?? "editorial writer failed";
      break;
    }
    version = revised.version;
    revisions.push(version);
  }
  const history = {
    version: input.policy.version,
    initial,
    assessments,
    judgments,
    revisions,
    mechanicalRuns,
    diagnostics,
    terminal,
  };
  const summary = await input.step("editorial-save-summary", () => input.save(history));
  return {
    draft: version.draft,
    metadata: version.metadata,
    history: { ...history, summary },
    reason,
    approvalEvent,
  };
}
