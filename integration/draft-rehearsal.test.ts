import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../src/controllers/artifact-store.js";
import { OperationStore } from "../src/controllers/operation-store.js";
import { readRetainedDraftRehearsal } from "../src/drafting/draft-rehearsal.js";
import { OwnerDraftRequestSchema } from "../src/content/owner-draft-authorization.js";
import { retainedRehearsalFixture } from "./draft-rehearsal-fixtures.js";

let dir: string, content: GitArtifactStore, operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "draft-rehearsal-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

describe("retained one-revision draft rehearsal", { timeout: 120000 }, () => {
  it("accepts the exact mechanically valid revision while preserving REVISE and making no new model calls", async () => {
    const f = await retainedRehearsalFixture(content, operations);
    expect(f.calls).toEqual({ writer: 1, assessor: 1, judge: 2 });
    const checked = await readRetainedDraftRehearsal({
      request: f.request,
      content,
      operations,
      requireCurrent: true,
    });
    expect(checked.judgment.decision).toBe("revise");
    expect(checked.summary.outcome).toBe("rejected");
    expect(checked.payload.mode).toBe("structured");
    expect(checked.markdown).toContain("editorial scope question");
    expect(f.calls).toEqual({ writer: 1, assessor: 1, judge: 2 });
    await expect(
      readRetainedDraftRehearsal({
        request: { ...f.request, metadata: f.denied.request.metadata },
        content,
        operations,
      }),
    ).rejects.toThrow();
    await expect(
      readRetainedDraftRehearsal({
        request: { ...f.request, judgment: f.denied.request.judgment },
        content,
        operations,
      }),
    ).rejects.toThrow();
  });

  it("bounds scope to two dummies and exactly one explicitly acknowledged Substack draft", () => {
    const ref = {
      repository: "content",
      commit: "a".repeat(40),
      path: "synthetic.json",
      hash: `sha256:${"b".repeat(64)}`,
    };
    const request = {
      version: "owner-draft-rehearsal-request-v1",
      requestId: "one",
      policy: "owner-one-revision-unpublished-v1",
      findingsAcknowledged: true,
      parent: { workflowKey: "synthetic", summary: ref },
      body: ref,
      metadata: ref,
      publication: ref,
      package: ref,
      assessment: ref,
      judgment: ref,
      mechanicalRun: ref,
      destinations: ["dummy-a", "dummy-b", "substack"].map((name, i) => ({
        name,
        provider: i < 2 ? "dummy" : "substack",
        action: "draft",
        capability: "unpublished-no-email-v1",
        identity: `sha256:${"c".repeat(64)}`,
      })),
    };
    expect(OwnerDraftRequestSchema.safeParse(request).success).toBe(true);
    expect(
      OwnerDraftRequestSchema.safeParse({ ...request, findingsAcknowledged: false }).success,
    ).toBe(false);
    expect(OwnerDraftRequestSchema.safeParse({ ...request, decision: "approve" }).success).toBe(
      false,
    );
    expect(
      OwnerDraftRequestSchema.safeParse({
        ...request,
        destinations: [...request.destinations, { ...request.destinations[2], name: "another" }],
      }).success,
    ).toBe(false);
    expect(
      OwnerDraftRequestSchema.safeParse({
        ...request,
        destinations: request.destinations.map((d) => ({ ...d, action: "publish" })),
      }).success,
    ).toBe(false);
  });
});
