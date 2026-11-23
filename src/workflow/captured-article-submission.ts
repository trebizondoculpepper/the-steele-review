import { createHash } from "node:crypto";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { ArticleRunInputSchema, articleRunKey, type ArticleRunInput } from "./article-run.js";
import { liveEditorialInput, articleAttemptHash } from "./article-attempt.js";
import { artifactRef, artifactReference } from "../drafting/publication-payload.js";
import { writeOnce } from "../research/job.js";

/** Source intent only: no editorial settings or credentials. Same capture reconnects its first exact input. */
export async function prepareCapturedArticleSubmission(input: {
  article: ArticleRunInput;
  content: GitArtifactStore;
  operations: Pick<OperationStore, "recordCapturedArticleIntent">;
}) {
  const article = ArticleRunInputSchema.parse({
    ...liveEditorialInput(input.article),
    operatorRequestId: `capture-${input.article.sourceVersion.slice(7)}`,
  });
  const hash = articleAttemptHash(article);
  const bytesIdentity = createHash("sha256").update(JSON.stringify(article)).digest("hex");
  const ref = await writeOnce(
    input.content,
    `article-submissions/${article.publicationId}/${article.postId}/${article.sourceVersion.slice(7)}/${bytesIdentity}.json`,
    article,
  );
  const binding = input.operations.recordCapturedArticleIntent({
    publicationId: article.publicationId,
    postId: article.postId,
    sourceVersion: article.sourceVersion,
    inputHash: hash,
    input: artifactReference(ref),
  });
  const retained = ArticleRunInputSchema.parse(
    JSON.parse(await input.content.read(artifactRef(binding.input))),
  );
  if (
    retained.publicationId !== binding.publicationId ||
    retained.postId !== binding.postId ||
    retained.sourceVersion !== binding.sourceVersion ||
    retained.operatorRequestId !== binding.requestId ||
    articleAttemptHash(retained) !== binding.inputHash ||
    articleRunKey(retained) !== binding.workflowKey ||
    retained.editorialExecution !== "live-policy-v1" ||
    retained.editorial
  )
    throw new Error("captured article submission mismatch");
  return { input: retained, workflowKey: binding.workflowKey };
}
