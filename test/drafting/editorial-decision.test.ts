import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  editorialDecisionPath,
  editorialDispositionKey,
  recordEditorialDecision,
} from "../../src/drafting/editorial-decision.js";

let dir: string;
let content: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-editorial-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const NOW = () => new Date("2026-01-01T00:00:00.000Z");

let version = 0;
async function draft(text = "# Draft\n\nA claim.") {
  version++;
  const ref = await content.write(`articles/pub/p1/draft-${version}.md`, text);
  return { repository: ref.repository, commit: ref.commit, path: ref.path, hash: `sha256:${ref.sha256}` };
}

const request = (over: Record<string, unknown> = {}) => ({
  requestId: "decision-1",
  publicationId: "pub",
  postId: "p1",
  draft: undefined as unknown,
  action: "approve" as const,
  ...over,
});

const decide = (over: Record<string, unknown> = {}, owner = "owner") => {
  const req = request(over);
  return recordEditorialDecision({
    content,
    operations,
    request: req as never,
    owner,
    now: NOW,
  });
};

describe("manual editorial decisions (#447)", () => {
  it("records an approval bound to the exact draft and its disposition", async () => {
    const ref = await draft();
    const out = await decide({ draft: ref });
    expect(out).toMatchObject({
      status: "recorded",
      duplicate: false,
      decision: {
        requestId: "decision-1",
        action: "approve",
        draft: ref,
        decidedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const stored = await content.lookup(
      editorialDecisionPath({
        publicationId: "pub",
        postId: "p1",
        draft: ref,
        requestId: "decision-1",
      }),
    );
    expect(stored).toBeDefined();
    expect(operations.operationStatus(editorialDispositionKey(ref.hash))?.status).toBe("completed");
  });

  it("returns the original record for a duplicate request instead of a second decision", async () => {
    const ref = await draft();
    const first = await decide({ draft: ref });
    const second = await decide({ draft: ref });
    expect(first).toMatchObject({ status: "recorded", duplicate: false });
    expect(second).toMatchObject({ status: "recorded", duplicate: true });
    // A repeated request with a different action is a conflict, not a rewrite.
    expect(await decide({ draft: ref, action: "reject" })).toEqual({ status: "conflict" });
  });

  it("refuses a stale or different draft version", async () => {
    const ref = await draft();
    const newer = await draft("# Draft\n\nChanged.");
    expect(await decide({ draft: { ...ref, hash: newer.hash } })).toEqual({
      status: "stale-version",
      reason: "version-mismatch",
    });
    expect(
      await decide({ draft: { ...ref, path: "articles/pub/p1/missing.md" } }),
    ).toEqual({ status: "stale-version", reason: "missing-draft" });
    expect(operations.operationStatus(editorialDispositionKey(ref.hash))).toBeUndefined();
  });

  it("keeps decisions for different versions separate", async () => {
    const first = await draft();
    const second = await draft("second version");
    expect(await decide({ draft: first, action: "approve", requestId: "a" })).toMatchObject({
      status: "recorded",
    });
    expect(
      await decide({ draft: second, action: "feedback", comment: "Tighten the second claim.", requestId: "b" }),
    ).toMatchObject({ status: "recorded", decision: { action: "feedback" } });
    expect(operations.operationStatus(editorialDispositionKey(first.hash))?.status).toBe("completed");
    expect(operations.operationStatus(editorialDispositionKey(second.hash))?.status).toBe("completed");
  });

  it("rejects invalid requests and feedback without a comment", async () => {
    const ref = await draft();
    expect(await decide({ draft: ref, requestId: "../escape" })).toEqual({
      status: "invalid",
      reason: "invalid-request",
    });
    expect(await decide({ draft: ref, action: "feedback" })).toEqual({
      status: "invalid",
      reason: "comment-required",
    });
    expect(
      await decide({ draft: ref, comment: "x".repeat(2001) }),
    ).toEqual({ status: "invalid", reason: "invalid-request" });
  });

  it("reuses a durable record after a restart without duplicating it", async () => {
    const ref = await draft();
    await decide({ draft: ref });
    // A fresh controller (restart) sees the completed operation and artifact.
    operations.close();
    operations = new OperationStore({ path: join(dir, "state.sqlite") });
    const again = await decide({ draft: ref });
    expect(again).toMatchObject({ status: "recorded", duplicate: true });
  });
});
