/**
 * Which research contract a new article run uses (#593). It is chosen once,
 * at submission, and serialised into the run's input: a replay always follows
 * the contract its input names, so changing the deployment setting never
 * changes how an in-flight invocation replays.
 */
export type ResearchExecution = "staged";

/** `{ researchExecution: "staged" }` when `STEELE_RESEARCH_STAGED=1`, else nothing. */
export function researchExecutionFromEnv(env: Record<string, string | undefined> = process.env): {
  researchExecution?: ResearchExecution;
} {
  return env.STEELE_RESEARCH_STAGED === "1" ? { researchExecution: "staged" } : {};
}

/**
 * Allowance selection for new runs (#596): when an allowance is configured,
 * new runs count only NEW research jobs against it, shared across the
 * article's rounds, and get one targeted follow-up round with reassessment
 * (#597). Serialised at submission like the execution contract.
 */
/**
 * Default research theme limit per article (#533): at most two new research
 * jobs (one per selected theme) unless a submitter sets another limit.
 * Distinct from provider spend and the research deadline.
 */
export const DEFAULT_RESEARCH_THEME_LIMIT = 2;

/** The submitted limit, or the default when none is configured (#533). */
export const researchThemeLimit = (limit: number | undefined): number =>
  limit ?? DEFAULT_RESEARCH_THEME_LIMIT;

export function researchSelectionFor(limit: number | undefined): {
  researchSelection?: "allowance-v1";
  researchFollowUp?: "one-round-v1";
} {
  return limit === undefined
    ? {}
    : { researchSelection: "allowance-v1", researchFollowUp: "one-round-v1" };
}

/**
 * The package readiness contract for new runs (#747): the librarian gathers
 * and selects material but never vetoes writing. Serialised at submission,
 * so runs started before it keep their old behaviour on replay.
 */
export const NON_BLOCKING_PACKAGE = { packageReadiness: "non-blocking-v1" } as const;
