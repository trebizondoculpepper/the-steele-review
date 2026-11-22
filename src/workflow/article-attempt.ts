import { createHash } from "node:crypto";
import type { OperationStore } from "../controllers/operation-store.js";
import { ArticleRunInputSchema, type ArticleRunInput } from "./article-run.js";

/**
 * Contract fields the deployment adds at submission (#596, #597, #747). They
 * describe how a new run executes, not what the operator asked for, so they
 * are left out of the request identity: a repeated request recorded before
 * a contract existed keeps the same input hash.
 */
const SUBMISSION_CONTRACT_FIELDS = [
  "researchSelection",
  "researchFollowUp",
  "packageReadiness",
] as const;

function attemptIdentity(input: ArticleRunInput): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const field of SUBMISSION_CONTRACT_FIELDS) delete out[field];
  return out;
}

/** The recorded request identity of one validated article input. */
export function articleAttemptHash(input: ArticleRunInput): string {
  return createHash("sha256")
    .update(JSON.stringify(attemptIdentity(input)))
    .digest("hex");
}

/** A new request is a new attempt, never a forged source version or reset workflow. */
export function recordArticleAttempt(
  operations: Pick<OperationStore, "recordArticleAttempt">,
  input: ArticleRunInput,
  requestId: string,
) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(requestId)) throw new Error("invalid-article-request");
  const valid = ArticleRunInputSchema.parse({ ...input, operatorRequestId: requestId });
  const identity = operations.recordArticleAttempt({
    publicationId: valid.publicationId,
    postId: valid.postId,
    sourceVersion: valid.sourceVersion,
    requestId,
    inputHash: createHash("sha256")
      .update(JSON.stringify(attemptIdentity(valid)))
      .digest("hex"),
  });
  return { identity, input: valid };
}

/** New normal operator attempts opt into live decisions; historical recorded inputs remain unchanged. */
export function liveEditorialInput(input: ArticleRunInput): ArticleRunInput {
  const { editorial: _historicalPolicy, ...rest } = input;
  return ArticleRunInputSchema.parse({ ...rest, editorialExecution: "live-policy-v1" });
}

export class NormalArticleAttemptError extends Error {
  constructor(readonly code: "input-mismatch" | "live-overrides") {
    super(`normal article attempt: ${code}`);
  }
}
/** An existing request keeps whichever versioned contract its recorded hash actually names. */
export function recordNormalArticleAttempt(
  operations: Pick<OperationStore, "recordArticleAttempt" | "articleAttempt">,
  input: ArticleRunInput,
  requestId: string,
  options: { legacyOverrides?: boolean } = {},
) {
  const existing = operations.articleAttempt(input.publicationId, input.postId, requestId);
  if (existing) {
    const candidates = [input, liveEditorialInput(input)].map((candidate) =>
      ArticleRunInputSchema.parse({ ...candidate, operatorRequestId: requestId }),
    );
    const selected = candidates.find(
      (candidate) => articleAttemptHash(candidate) === existing.inputHash,
    );
    if (!selected) throw new NormalArticleAttemptError("input-mismatch");
    return recordArticleAttempt(operations, selected, requestId);
  }
  if (options.legacyOverrides) throw new NormalArticleAttemptError("live-overrides");
  return recordArticleAttempt(operations, liveEditorialInput(input), requestId);
}
