import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  recordArticleAttempt,
  recordNormalArticleAttempt,
} from "../../src/workflow/article-attempt.js";
import { ArticleRunInputSchema, articleRunKey } from "../../src/workflow/article-run.js";
import {
  DEFAULT_EDITORIAL_POLICY,
  editorialPolicyFromEnv,
  exhaustionAction,
  sameEditorialPolicy,
} from "../../src/workflow/editorial-contract.js";
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
      // A request recorded before the submission contracts existed still
      // attaches after upgrade; the returned input is the new one.
      const upgraded = recordArticleAttempt(
        operations,
        {
          ...input,
          researchSelection: "allowance-v1",
          researchFollowUp: "one-round-v1",
          packageReadiness: "non-blocking-v1",
        },
        "owner-request-one",
      );
      expect(upgraded.identity).toEqual(one.identity);
      expect(upgraded.input.packageReadiness).toBe("non-blocking-v1");
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
      editorialPolicyFromEnv({
        STEELE_EDITORIAL_MAX_REVISIONS: "1",
        STEELE_EDITORIAL_DEADLINE_MS: "3000",
      }),
    ).toMatchObject({ maxRevisions: 1, deadlineMs: 3000 });
    expect(() => editorialPolicyFromEnv({ STEELE_EDITORIAL_MAX_REVISIONS: "999" })).toThrow();
    // #734: the exhaustion action is snapshotted at submission, default stop.
    // The default is not written, so request-id input hashes are unchanged.
    expect(editorialPolicyFromEnv({})).toEqual(DEFAULT_EDITORIAL_POLICY);
    expect(editorialPolicyFromEnv({})).not.toHaveProperty("onExhausted");
    expect(
      editorialPolicyFromEnv({ STEELE_EDITORIAL_EXHAUSTION_ACTION: "stop" }),
    ).not.toHaveProperty("onExhausted");
    expect(
      editorialPolicyFromEnv({ STEELE_EDITORIAL_EXHAUSTION_ACTION: "create-unpublished-draft" }),
    ).toMatchObject({ onExhausted: "create-unpublished-draft" });
    expect(() =>
      editorialPolicyFromEnv({ STEELE_EDITORIAL_EXHAUSTION_ACTION: "publish" }),
    ).toThrow();
    // An input saved before the action existed stays valid and means stop.
    const savedBefore = { ...DEFAULT_EDITORIAL_POLICY };
    const parsedLegacy = ArticleRunInputSchema.parse({
      ...input,
      editorial: savedBefore,
    }).editorial!;
    expect(parsedLegacy).not.toHaveProperty("onExhausted");
    expect(exhaustionAction(parsedLegacy)).toBe("stop");
    expect(
      sameEditorialPolicy(parsedLegacy, { ...DEFAULT_EDITORIAL_POLICY, onExhausted: "stop" }),
    ).toBe(true);
    expect(
      sameEditorialPolicy(parsedLegacy, {
        ...DEFAULT_EDITORIAL_POLICY,
        onExhausted: "create-unpublished-draft",
      }),
    ).toBe(false);
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

it("normal retries select the recorded live or historical contract by its hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "normal-contract-"));
  const operations = new OperationStore({ path: join(dir, "state.sqlite") });
  try {
    const old = recordArticleAttempt(operations, input, "historical-request");
    expect(
      recordNormalArticleAttempt(operations, input, "historical-request", {
        legacyOverrides: true,
      }),
    ).toEqual(old);
    expect(
      recordNormalArticleAttempt(operations, input, "historical-request").input.editorialExecution,
    ).toBeUndefined();
    const live = recordNormalArticleAttempt(operations, input, "new-request");
    expect(live.input.editorialExecution).toBe("live-policy-v1");
    expect(live.input.editorial).toBeUndefined();
    expect(
      recordNormalArticleAttempt(
        operations,
        { ...input, editorial: { ...DEFAULT_EDITORIAL_POLICY, maxRevisions: 5 } },
        "new-request",
      ),
    ).toEqual(live);
    expect(() =>
      recordNormalArticleAttempt(
        operations,
        { ...input, sourceUrl: "https://different.example/post" },
        "historical-request",
      ),
    ).toThrow("input-mismatch");
    expect(() =>
      recordNormalArticleAttempt(operations, input, "unrecorded-overrides", {
        legacyOverrides: true,
      }),
    ).toThrow("live-overrides");
    expect(
      operations.articleAttempt(input.publicationId, input.postId, "unrecorded-overrides"),
    ).toBeUndefined();
  } finally {
    operations.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("retries a request recorded before the default research limit (#533)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "default-limit-"));
  const operations = new OperationStore({ path: join(dir, "state.sqlite") });
  try {
    // Recorded before #533: no limit, so the whole plan.
    const { researchRequestLimit: _l, ...unlimited } = input;
    const old = recordNormalArticleAttempt(operations, unlimited, "pre-default");
    const defaulted = {
      ...input,
      researchRequestLimit: 2,
      researchSelection: "allowance-v1" as const,
      researchFollowUp: "one-round-v1" as const,
    };
    // A retry that only defaulted the limit attaches to the recorded attempt.
    expect(
      recordNormalArticleAttempt(operations, defaulted, "pre-default", {
        defaultedResearchLimit: true,
      }),
    ).toEqual(old);
    // An explicitly given limit is never silently dropped.
    expect(() => recordNormalArticleAttempt(operations, defaulted, "pre-default")).toThrow(
      "input-mismatch",
    );
    // A new request records the defaulted limit.
    expect(
      recordNormalArticleAttempt(operations, defaulted, "post-default", {
        defaultedResearchLimit: true,
      }).input.researchRequestLimit,
    ).toBe(2);
  } finally {
    operations.close();
    await rm(dir, { recursive: true, force: true });
  }
});
