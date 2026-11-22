import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { recordArticleAttempt } from "../../src/workflow/article-attempt.js";
import { ArticleRunInputSchema, articleRunKey } from "../../src/workflow/article-run.js";
import { DEFAULT_EDITORIAL_POLICY } from "../../src/workflow/editorial-contract.js";
const input = {
  publicationId: "fixture",
  postId: "post",
  sourceVersion: `sha256:${"a".repeat(64)}`,
  sourceUrl: "https://source.example/post",
  researchDeadlineMs: 1000,
  researchRequestLimit: 2,
  editorial: DEFAULT_EDITORIAL_POLICY,
};
describe("explicit durable article attempt identity", () => {
  it("preserves real source version and prior workflow while the same request attaches once across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "article-attempt-"));
    let operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      const one = recordArticleAttempt(operations, input, "owner-request-one");
      expect(one.identity.workflowKey).toMatch(new RegExp(`^${articleRunKey(input)}~run-`));
      expect(one.input.sourceVersion).toBe(input.sourceVersion);
      expect(one.input.operatorRequestId).toBe("owner-request-one");
      operations.close();
      operations = new OperationStore({ path: join(dir, "state.sqlite") });
      expect(recordArticleAttempt(operations, input, "owner-request-one")).toEqual(one);
      const two = recordArticleAttempt(operations, input, "owner-request-two");
      expect(two.identity.workflowKey).not.toBe(one.identity.workflowKey);
      expect(() =>
        recordArticleAttempt(
          operations,
          { ...input, researchRequestLimit: 1 },
          "owner-request-one",
        ),
      ).toThrow();
      const records = operations.articleAttempts("fixture", "post", input.sourceVersion);
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.workflowKey)).toContain(one.identity.workflowKey);
      expect(operations.articleAttempts("fixture", "post", `sha256:${"b".repeat(64)}`)).toEqual([]);
      expect(() => recordArticleAttempt(operations, input, "../bad")).toThrow();
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("serializes the new editorial journal contract while old inputs retain the legacy version", () => {
    const legacy = { ...input, editorial: undefined };
    expect(ArticleRunInputSchema.parse(legacy).editorial).toBeUndefined();
    expect(ArticleRunInputSchema.parse(input).editorial).toEqual(DEFAULT_EDITORIAL_POLICY);
    expect(
      ArticleRunInputSchema.safeParse({
        ...input,
        editorial: { ...DEFAULT_EDITORIAL_POLICY, version: "unreviewed" },
      }).success,
    ).toBe(false);
    expect(
      ArticleRunInputSchema.safeParse({
        ...input,
        editorial: { ...DEFAULT_EDITORIAL_POLICY, maxRevisions: 1000 },
      }).success,
    ).toBe(false);
  });
});
