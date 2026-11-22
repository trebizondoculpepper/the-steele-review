import { createHash } from "node:crypto";
import {
  EditorialContinuationInputSchema,
  EditorialContinuationError,
  readEditorialContinuation,
} from "../drafting/editorial-continuation.js";
import { classifyArticlePath } from "../drafting/article-identity.js";
import { artifactRef, artifactReference, sameArtifact } from "../drafting/publication-payload.js";
import {
  EditorialContinuationIntentSchema,
  EditorialContinuationRunInputSchema,
  type EditorialContinuationIntent,
  type EditorialContinuationRunInput,
} from "../content/editorial-continuation-contract.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import type { ParsedSourceMetadata } from "../content/source-metadata.js";
import type { ParentCompletionPort } from "../controllers/editorial-continuation-ingress.js";
import type { EditorialPolicy } from "./editorial-contract.js";
import { writeOnce } from "../research/job.js";
export class ContinuationSubmissionError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "identity-conflict"
      | "parent-not-complete"
      | "parent-result-mismatch"
      | "policy-mismatch",
  ) {
    super(`editorial continuation: ${code}`);
  }
}
export const continuationIntentHash = (value: EditorialContinuationIntent) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const continuationArticle = (seed: EditorialContinuationIntent["seed"]) => {
  const path = classifyArticlePath(seed.body.path);
  if (!path || path.kind !== "canonical" || path.part !== "body")
    throw new ContinuationSubmissionError("invalid-input");
  return { publicationId: path.publicationId, postId: path.postId };
};
export async function requireParentCompletion(
  port: ParentCompletionPort,
  seed: EditorialContinuationIntent["seed"],
) {
  const parent = await port.read(seed.parent.workflowKey);
  if (parent.state !== "completed") throw new ContinuationSubmissionError("parent-not-complete");
  if (
    parent.outcome !== "rejected" ||
    !parent.summary ||
    !sameArtifact(parent.summary, seed.parent.summary)
  )
    throw new ContinuationSubmissionError("parent-result-mismatch");
}
export async function loadContinuationIntent(
  content: Pick<GitArtifactStore, "read">,
  input: EditorialContinuationRunInput,
) {
  const intent = EditorialContinuationIntentSchema.parse(
    JSON.parse(await content.read(artifactRef(input.intent))),
  );
  const article = continuationArticle(intent.seed),
    hash = continuationIntentHash(intent);
  if (
    intent.requestId !== input.requestId ||
    input.intent.path !==
      `editorial-continuation-intents/${article.publicationId}/${article.postId}/${hash}.json`
  )
    throw new ContinuationSubmissionError("identity-conflict");
  return intent;
}
export const recordContinuationIntent = (
  operations: Pick<OperationStore, "recordEditorialContinuation">,
  intent: EditorialContinuationIntent,
  ref: EditorialContinuationRunInput["intent"],
  sourceVersion: string,
) =>
  operations.recordEditorialContinuation({
    ...continuationArticle(intent.seed),
    sourceVersion,
    requestId: intent.requestId,
    inputHash: continuationIntentHash(intent),
    intent: ref,
    parentSummary: intent.seed.parent.summary,
  });
/** Existing exact intents attach before a current-base check: this invocation may have made that base stale itself. */
export async function prepareEditorialContinuation(input: {
  seed: unknown;
  requestId: string;
  policy: EditorialPolicy;
  content: GitArtifactStore;
  archive: Pick<GitArtifactStore, "read" | "lookup">;
  operations: Pick<
    OperationStore,
    "articleAttempt" | "editorialContinuationAttempt" | "recordEditorialContinuation"
  >;
  sourceMetadata?: ParsedSourceMetadata;
  parentCompletion: ParentCompletionPort;
}) {
  const parsed = EditorialContinuationInputSchema.safeParse(input.seed);
  if (!parsed.success) throw new ContinuationSubmissionError("invalid-input");
  const seed = parsed.data,
    article = continuationArticle(seed);
  const existing = input.operations.editorialContinuationAttempt(
    article.publicationId,
    article.postId,
    input.requestId,
  );
  if (existing) {
    const run = EditorialContinuationRunInputSchema.parse({
      version: "editorial-continuation-run-v1",
      requestId: input.requestId,
      intent: existing.intent,
    });
    const intent = await loadContinuationIntent(input.content, run);
    if (
      JSON.stringify(intent.seed) !== JSON.stringify(seed) ||
      continuationIntentHash(intent) !== existing.inputHash
    )
      throw new ContinuationSubmissionError("identity-conflict");
    return { input: run, workflowKey: existing.workflowKey, intent, repeatedIntent: true };
  }
  const intent = EditorialContinuationIntentSchema.parse({
    version: "editorial-continuation-intent-v1",
    requestId: input.requestId,
    seed,
    policy: input.policy,
  });
  const validated = await readEditorialContinuation({ ...input, request: seed });
  await requireParentCompletion(input.parentCompletion, seed);
  const hash = continuationIntentHash(intent),
    ref = await writeOnce(
      input.content,
      `editorial-continuation-intents/${article.publicationId}/${article.postId}/${hash}.json`,
      intent,
    );
  const run = EditorialContinuationRunInputSchema.parse({
    version: "editorial-continuation-run-v1",
    requestId: input.requestId,
    intent: artifactReference(ref),
  });
  if (JSON.stringify(await loadContinuationIntent(input.content, run)) !== JSON.stringify(intent))
    throw new ContinuationSubmissionError("identity-conflict");
  const identity = recordContinuationIntent(
    input.operations,
    intent,
    run.intent,
    validated.article.sourceVersion,
  );
  return { input: run, workflowKey: identity.workflowKey, intent, repeatedIntent: false };
}
/** Permanent input refusals only; storage/transport failures must retain bounded retry semantics. */
export const continuationDomainCode = (error: unknown): string | undefined =>
  error instanceof EditorialContinuationError || error instanceof ContinuationSubmissionError
    ? error.code
    : undefined;
