import { z } from "zod";

export const AssertionKindSchema = z.enum([
  "assertion",
  "quotation",
  "question",
  "speculation",
]);

/** Why a grounded assertion is a refinement candidate, not an accepted claim. */
export const CandidateReasonSchema = z.enum([
  "no-theme",
  "question",
  "unclear-referent",
  "not-self-contained",
]);
export type CandidateReason = z.infer<typeof CandidateReasonSchema>;

// Only personal pronouns standing for unnamed actors are flagged. "It",
// "this" and "that" also open impersonal or self-contained constructions
// ("It is illegal to…", "This treaty bans…"), so they are left to the prompt
// and source inspection rather than rejected structurally.
const LEADING_PRONOUN = /^(?:they|them|he|she|we|you)\b/i;

// A statement can restate a quotation without asserting anything checkable: a
// rallying cry or instruction carries no proposition a reader can verify.
// Exact equality with the passage is deliberately *not* a rejection reason,
// because a short self-contained quotation is legitimate (#212).
//
// Only a closed vocabulary counts as a pure call to action: the imperative
// followed by at most one object word and trailing adverbs. Anything else -
// "Stop signs prevent accidents", "Stop spraying because aircraft contaminate
// the soil" - carries a checkable clause and stays an accepted claim. A
// general "does this sentence assert something" test is not decidable with a
// pattern, so the rest is left to the prompt and to source inspection.
const PURE_CALL_TO_ACTION =
  /^(?:stop|do not|don'?t|wake up|stand up|act now)\s+(?:(?:\w+ing|\w+)\s+)?(?:us|them|it|this|that|now|today|everywhere|immediately)(?:\s+(?:now|today|everywhere|immediately))*[.!]*$/i;

/** A pure call to action, with no asserted proposition to check. */
function isCallToActionOnly(statement: string): boolean {
  return PURE_CALL_TO_ACTION.test(statement.trim());
}

/**
 * Structural acceptance checks. Semantic self-containment also relies on the
 * prompt and on source inspection (#184/#212); this catches the clear cases:
 * no theme link, a question, a statement that opens with an unresolved
 * personal pronoun ("They are spraying us") instead of naming its subject, or
 * a pure call to action with no factual assertion.
 */
export function candidateReasons(
  kind: z.infer<typeof AssertionKindSchema>,
  themeIds: readonly string[],
  statement: string,
): CandidateReason[] {
  const reasons: CandidateReason[] = [];
  if (themeIds.length === 0) reasons.push("no-theme");
  if (kind === "question") reasons.push("question");
  if (LEADING_PRONOUN.test(statement.trim())) reasons.push("unclear-referent");
  if (isCallToActionOnly(statement)) reasons.push("not-self-contained");
  return reasons;
}
