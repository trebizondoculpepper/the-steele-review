/** Explicit isolated Git/state composition; no providers or broker connection. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../src/controllers/artifact-store.js";
import { OperationStore } from "../src/controllers/operation-store.js";
import { prepareCapturedArticleSubmission } from "../src/workflow/captured-article-submission.js";
import { articleRunKey } from "../src/workflow/article-run.js";
import { articleAttemptHash } from "../src/workflow/article-attempt.js";
it(
  "pins the first normal capture input without editorial snapshots and reattaches after capture/contract changes",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "captured-submit-"));
    const content = new GitArtifactStore({ repoPath: dir, repository: "content" });
    await content.initialise();
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    const article = {
      publicationId: "pub",
      postId: "post",
      sourceVersion: "sha256:" + "a".repeat(64),
      sourceUrl: "https://publication.example/post",
      researchDeadlineMs: 1800000,
      researchRequestLimit: 2,
      editorial: {
        version: "assess-judge-v1" as const,
        maxRevisions: 1,
        deadlineMs: 120000,
        onExhausted: "create-unpublished-draft" as const,
      },
      source: {
        namespace: "substack/pub",
        itemId: "post",
        artifact: {
          repository: "archive",
          commit: "b".repeat(40),
          path: "substack/pub/post/collected.json",
          sha256: "c".repeat(64),
        },
      },
    };
    try {
      const first = await prepareCapturedArticleSubmission({ article, content, operations });
      expect(first.workflowKey).toBe(articleRunKey(article));
      expect(first.input.editorial).toBeUndefined();
      expect(first.input.editorialExecution).toBe("live-policy-v1");
      const changed = {
        ...article,
        packageReadiness: "non-blocking-v1" as const,
        source: {
          ...article.source,
          artifact: { ...article.source.artifact, commit: "d".repeat(40) },
        },
        editorial: { ...article.editorial, maxRevisions: 0 },
      };
      expect(
        await prepareCapturedArticleSubmission({ article: changed, content, operations }),
      ).toEqual(first);
      expect(
        operations.articleAttempt("pub", "post", first.input.operatorRequestId!)?.inputHash,
      ).toBe(articleAttemptHash(first.input));
      expect(
        await prepareCapturedArticleSubmission({
          article: { ...article, packageReadiness: "non-blocking-v1" },
          content,
          operations,
        }),
      ).toEqual(first);
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
