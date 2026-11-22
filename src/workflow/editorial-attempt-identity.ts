import { createHash } from "node:crypto";
import type { ArticleRunInput } from "./article-run.js";

/** Stable role/capture identity for either operator reruns or dashboard credit recovery. */
export function editorialAttemptIdentity(input: ArticleRunInput) {
  const generation = input.recoveryGeneration ?? 0;
  const identity = [
    input.publicationId,
    input.postId,
    input.sourceVersion,
    input.operatorRequestId ?? null,
    generation,
  ];
  const attemptId = `editorial-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`;
  const recoveryId =
    input.operatorRequestId ??
    (generation > 0
      ? `dashboard-recovery-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`
      : undefined);
  return { attemptId, recoveryId };
}
