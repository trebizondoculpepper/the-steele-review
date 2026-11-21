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
    expect(
      operations.editorialDisposition(editorialDispositionKey({ publicationId: "pub", postId: "p1", draft: ref }))
        ?.decision,
    ).toMatchObject({ path: expect.stringContaining("decision-1") });
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

  it("refuses a completed request replayed for a different artifact path", async () => {
    const first = await draft("identical bytes");
    // Same bytes stored at another path: a different artifact identity.
    const secondRef = await content.write("articles/pub/p1/copy.md", "identical bytes");
    const second = {
      repository: secondRef.repository,
      commit: secondRef.commit,
      path: secondRef.path,
      hash: `sha256:${secondRef.sha256}`,
    };
    expect(second.hash).toBe(first.hash);
    expect(await decide({ draft: first })).toMatchObject({ status: "recorded" });
    expect(await decide({ draft: second })).toEqual({ status: "conflict" });
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
    expect(
      operations.editorialDisposition(editorialDispositionKey({ publicationId: "pub", postId: "p1", draft: ref })),
    ).toBeUndefined();
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
    const disposition = (draftHash: string, draftRef: typeof first) =>
      operations.editorialDisposition(
        editorialDispositionKey({ publicationId: "pub", postId: "p1", draft: { ...draftRef, hash: draftHash } }),
      );
    expect(disposition(first.hash, first)?.decision).toMatchObject({
      path: expect.stringContaining("/a.json"),
    });
    expect(disposition(second.hash, second)?.decision).toMatchObject({
      path: expect.stringContaining("/b.json"),
    });
  });

  it("lets a newer decision replace the current disposition", async () => {
    const ref = await draft();
    expect(await decide({ draft: ref, action: "approve", requestId: "a" })).toMatchObject({
      status: "recorded",
    });
    const key = editorialDispositionKey({ publicationId: "pub", postId: "p1", draft: ref });
    expect(operations.editorialDisposition(key)).toMatchObject({
      decidedAt: "2026-01-01T00:00:00.000Z",
    });
    // A later, distinct reject request for the same revision supersedes it.
    const later = await recordEditorialDecision({
      content,
      operations,
      request: request({ draft: ref, action: "reject", requestId: "b" }) as never,
      owner: "owner",
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(later).toMatchObject({ status: "recorded", duplicate: false });
    expect(operations.editorialDisposition(key)).toMatchObject({
      decidedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("does not let a late older decision regress the disposition", async () => {
    const ref = await draft();
    const key = editorialDispositionKey({ publicationId: "pub", postId: "p1", draft: ref });
    await recordEditorialDecision({
      content,
      operations,
      request: request({ draft: ref, action: "approve", requestId: "a" }) as never,
      owner: "owner",
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    await recordEditorialDecision({
      content,
      operations,
      request: request({ draft: ref, action: "reject", requestId: "b" }) as never,
      owner: "owner",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(operations.editorialDisposition(key)).toMatchObject({
      decidedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("keeps the disposition separate for identical drafts in different posts", async () => {
    const ref = await draft();
    const otherPost = `editorial-disposition:${ref.hash}`;
    const a = editorialDispositionKey({ publicationId: "pub", postId: "p1", draft: ref });
    const b = editorialDispositionKey({ publicationId: "pub", postId: "p2", draft: ref });
    expect(a).not.toBe(b);
    expect(a).not.toBe(otherPost);
  });

  it("refuses a draft reference from another repository", async () => {
    const ref = await draft();
    expect(
      await decide({ draft: { ...ref, repository: "someone-elses-repo" } }),
    ).toEqual({ status: "stale-version", reason: "version-mismatch" });
  });

  it("recovers a crashed decision only when it matches the request", async () => {
    const ref = await draft();
    const path = editorialDecisionPath({
      publicationId: "pub",
      postId: "p1",
      draft: ref,
      requestId: "decision-1",
    });
    // Simulate a crash after the artifact write: the record exists, but the
    // operation was never completed.
    await content.write(
      path,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          requestId: "decision-1",
          publicationId: "pub",
          postId: "p1",
          draft: ref,
          action: "approve",
          decidedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    const recovered = await decide({ draft: ref });
    expect(recovered).toMatchObject({
      status: "recorded",
      decision: { action: "approve", decidedAt: "2026-01-01T00:00:00.000Z" },
    });
    // A conflicting reuse of the same request ID is refused, not rewritten.
    expect(await decide({ draft: ref, action: "reject" })).toEqual({ status: "conflict" });
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
