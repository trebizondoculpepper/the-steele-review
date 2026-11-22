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
