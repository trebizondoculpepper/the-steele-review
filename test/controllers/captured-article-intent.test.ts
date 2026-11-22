import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";
const candidate = {
  publicationId: "pub",
  postId: "post",
  sourceVersion: "sha256:" + "a".repeat(64),
  inputHash: "b".repeat(64),
  input: {
    repository: "content",
    commit: "c".repeat(40),
    path: "article-submissions/synthetic.json",
    hash: "sha256:" + "d".repeat(64),
  },
};
it("keeps the legacy base workflow key and first exact capture intent across competing candidates and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "captured-intent-"));
  let operations = new OperationStore({ path: join(dir, "state.sqlite") });
  try {
    const first = operations.recordCapturedArticleIntent(candidate);
    expect(first.workflowKey).toBe("pub/post@" + "a".repeat(32));
    expect(first.requestId).toBe("capture-" + "a".repeat(64));
    expect(
      operations.recordCapturedArticleIntent({
        ...candidate,
        inputHash: "e".repeat(64),
        input: { ...candidate.input, hash: "sha256:" + "f".repeat(64) },
      }),
    ).toEqual(first);
    operations.close();
    operations = new OperationStore({ path: join(dir, "state.sqlite") });
    expect(operations.recordCapturedArticleIntent(candidate)).toEqual(first);
    expect(operations.articleAttempt("pub", "post", first.requestId)).toMatchObject({
      workflowKey: first.workflowKey,
      inputHash: first.inputHash,
    });
    expect(operations.articleAttempts("pub", "post", candidate.sourceVersion)).toHaveLength(1);
  } finally {
    operations.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("does not reserve a capture slot when its deterministic request conflicts with existing operator state", () => {
  const dir = mkdtempSync(join(tmpdir(), "captured-intent-"));
  const operations = new OperationStore({ path: join(dir, "state.sqlite") });
  try {
    operations.recordArticleAttempt({
      publicationId: "pub",
      postId: "post",
      sourceVersion: candidate.sourceVersion,
      requestId: "capture-" + "a".repeat(64),
      inputHash: "e".repeat(64),
    });
    expect(() => operations.recordCapturedArticleIntent(candidate)).toThrow("invalid-input");
    expect(operations.listOperations("captured-article-intent:")).toHaveLength(0);
    expect(operations.recordCapturedArticleIntent({ ...candidate, postId: "other" }).postId).toBe(
      "other",
    );
  } finally {
    operations.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
