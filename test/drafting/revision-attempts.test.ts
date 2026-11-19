import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  REVISION_DECIDED_SUBJECT,
  RevisionAttemptStore,
  type AttemptRecord,
} from "../../src/drafting/revision-attempts.js";

const h = (c: string) => `sha256:${c.repeat(64)}`;
const ref = (path: string, c: string) => ({
  repository: "drafts",
  commit: c.repeat(40),
  path,
  hash: h(c),
});
const post = { publicationId: "pub", postId: "p" };
const brief = ref("briefs/pub/p/b.json", "b");
const attempt = (
  revision: number,
  over: Partial<AttemptRecord> = {},
): Omit<AttemptRecord, "schemaVersion"> => ({
  ...post,
  brief,
  revision,
  draft: ref(`drafts/pub/p/${revision}.md`, String(revision + 1)),
  report: ref(`verifications/pub/p/${revision}.json`, "e"),
  decision: { action: "redraft", revision: revision + 1, feedback: [{ passage: "x" }] },
  ...over,
});

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-revisions-"));
  await mkdir(join(dir, "drafts"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "drafts"), repository: "drafts" });
  await artifacts.initialise();
  clock = 1_000_000;
  operations = new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
const store = () => new RevisionAttemptStore({ artifacts, operations, leaseMs: 1_000 });

describe("RevisionAttemptStore", () => {
  it("records an immutable attempt with every reference and a pending follow-up", async () => {
    const s = store();
    const begun = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w" });
    if (begun.kind !== "claimed") throw new Error(begun.kind);
    const done = await s.finish(begun.claim, attempt(0));
    expect(done).toMatchObject({
      kind: "recorded",
      reused: false,
      artifact: { path: `revisions/pub/p/${"b".repeat(64)}/0/1.json` },
    });
    if (done.kind !== "recorded") return;
    const saved = JSON.parse(await artifacts.read(done.artifact));
    expect(saved).toMatchObject({
      brief,
      draft: attempt(0).draft,
      report: attempt(0).report,
      revision: 0,
    });
    const [event] = operations.duePendingEvents(10, REVISION_DECIDED_SUBJECT);
    expect(JSON.parse(event!.payload).data).toMatchObject({
      revision: 0,
      action: "redraft",
      brief,
    });
  });

  it("reuses a recorded attempt instead of producing a duplicate revision", async () => {
    const s = store();
    const begun = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w" });
    if (begun.kind !== "claimed") throw new Error(begun.kind);
    await s.finish(begun.claim, attempt(0));
    const again = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w" });
    expect(again).toMatchObject({ kind: "already-recorded", record: { revision: 0 } });
    expect(operations.duePendingEvents(10, REVISION_DECIDED_SUBJECT)).toHaveLength(1);
  });

  it("recovers an attempt committed before its state transition", async () => {
    const s = store();
    const begun = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w" });
    if (begun.kind !== "claimed") throw new Error(begun.kind);
    // The worker committed the record, then stopped before completing.
    await artifacts.write(
      s.path(post, brief.hash, 0, 1),
      `${JSON.stringify({ schemaVersion: 1, ...attempt(0) }, null, 2)}\n`,
    );
    clock += 2_000;
    const retry = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w2" });
    expect(retry).toMatchObject({ kind: "already-recorded", record: { revision: 0 } });
    expect(operations.duePendingEvents(10, REVISION_DECIDED_SUBJECT)).toHaveLength(1);
  });

  it("rejects a stale worker whose lease was taken over", async () => {
    const s = store();
    const stale = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w1" });
    if (stale.kind !== "claimed") throw new Error(stale.kind);
    clock += 2_000;
    const current = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w2" });
    if (current.kind !== "claimed") throw new Error(current.kind);
    expect(await s.finish(current.claim, attempt(0))).toMatchObject({ kind: "recorded" });
    expect(await s.finish(stale.claim, attempt(0))).toEqual({ kind: "stale-owner" });
  });

  it("refuses a conflicting outcome for an attempt already committed", async () => {
    const s = store();
    const begun = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w" });
    if (begun.kind !== "claimed") throw new Error(begun.kind);
    await artifacts.write(
      s.path(post, brief.hash, 0, 1),
      `${JSON.stringify({ schemaVersion: 1, ...attempt(0) }, null, 2)}\n`,
    );
    const other = attempt(0, { decision: { action: "skip", reason: "revisions-exhausted" } });
    expect(await s.finish(begun.claim, other)).toEqual({
      kind: "failed",
      reason: "conflicting-record",
      retryable: false,
    });
  });

  it("keeps a stale holder's late commit from blocking the current holder", async () => {
    const s = store();
    const stale = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w1" });
    if (stale.kind !== "claimed") throw new Error(stale.kind);
    clock += 2_000;
    const current = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w2" });
    if (current.kind !== "claimed") throw new Error(current.kind);
    // The stale holder's slow write lands after the takeover, at its own path.
    await artifacts.write(
      s.path(post, brief.hash, 0, stale.claim.attempt),
      `${JSON.stringify({ schemaVersion: 1, ...attempt(0, { decision: { action: "skip", reason: "x" } }) }, null, 2)}\n`,
    );
    const done = await s.finish(current.claim, attempt(0));
    expect(done).toMatchObject({
      kind: "recorded",
      artifact: { path: s.path(post, brief.hash, 0, current.claim.attempt) },
    });
  });

  it("advances revisions in order and links each to its predecessor", async () => {
    const s = store();
    expect(await s.begin({ post, briefHash: brief.hash, revision: 1, owner: "w" })).toEqual({
      kind: "out-of-order",
    });
    const first = await s.begin({ post, briefHash: brief.hash, revision: 0, owner: "w" });
    if (first.kind !== "claimed") throw new Error(first.kind);
    const r0 = await s.finish(first.claim, attempt(0));
    const second = await s.begin({ post, briefHash: brief.hash, revision: 1, owner: "w" });
    if (second.kind !== "claimed" || r0.kind !== "recorded") throw new Error("setup");
    expect(second.previous).toMatchObject({ path: r0.artifact.path });
    const done = await s.finish(second.claim, attempt(1, { previous: second.previous! }));
    expect(done).toMatchObject({ kind: "recorded" });
  });
});
