import { createHash } from "node:crypto";
import type { OperationStore } from "../controllers/operation-store.js";
import { ArticleRunInputSchema, articleRunKey, type ArticleRunInput } from "./article-run.js";

/** A new request is a new attempt, never a forged source version or reset workflow. */
export function recordArticleAttempt(
  operations: Pick<OperationStore, "recordArticleAttempt">,
  input: ArticleRunInput,
  requestId: string,
) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(requestId)) throw new Error("invalid-article-request");
  const valid = ArticleRunInputSchema.parse({ ...input, operatorRequestId: requestId });
  const workflowKey = `${articleRunKey(valid)}~run-${createHash("sha256").update(requestId).digest("hex").slice(0, 16)}`;
  const identity = operations.recordArticleAttempt({
    publicationId: valid.publicationId,
    postId: valid.postId,
    sourceVersion: valid.sourceVersion,
    requestId,
    inputHash: createHash("sha256").update(JSON.stringify(valid)).digest("hex"),
    workflowKey,
  });
  return { identity, input: valid };
}
