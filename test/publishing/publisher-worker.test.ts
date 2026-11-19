import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore, type ArtifactRef } from "../../src/controllers/artifact-store.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { ControlledSubstackClient } from "../../src/publishing/controlled-destination.js";
import { SubstackDestinationController } from "../../src/publishing/destination.js";
import {
  ARTICLE_PUBLISHED_SUBJECT,
  PublisherWorker,
} from "../../src/publishing/publisher-worker.js";

const reference = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
let client: ControlledSubstackClient;
let clock: Date;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-publisher-"));
  await mkdir(join(dir, "drafts"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "drafts"), repository: "drafts" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
  clock = new Date("2026-11-01T12:00:00Z");
  client = new ControlledSubstackClient("https://destination.example", () => clock);
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

/** Commit a synthetic approved draft and its approving report; return the approval event. */
async function approved(postId: string, body = "A synthetic response.", ingestionReason = "live") {
  const draft = await artifacts.write(
    `drafts/pub/${postId}/d.md`,
    `Original post: https://pub.substack.com/p/${postId}\n\n${body}\n`,
  );
  const report = await artifacts.write(
    `verifications/pub/${postId}/r.json`,
    `${JSON.stringify({
      schemaVersion: 1,
      verdict: "approve",
      draft: { path: draft.path, commit: draft.commit, hash: `sha256:${draft.sha256}` },
      brief: { path: "briefs/b.json", commit: "b".repeat(40), hash: `sha256:${"c".repeat(64)}` },
      issues: [],
      attempt: 1,
      maxAttempts: 3,
      rejectedIssues: 0,
    })}\n`,
  );
  return {
    specversion: "1.0",
    id: `approval-${postId}`,
    source: "urn:steele:drafting:verifier",
    type: "org.steele.draft.verified.v1",
    time: "2026-11-01T00:00:00Z",
    subject: `substack/pub/${postId}`,
    datacontenttype: "application/json",
    data: {
      publicationId: "pub",
      postId,
      ingestionReason,
      verdict: "approve",
      draft: reference(draft),
      report: reference(report),
    },
  };
}
function message(event: unknown) {
  const m = {
    data: new TextEncoder().encode(JSON.stringify(event)),
    deliveryCount: 1,
    acks: 0,
    naks: [] as number[],
    terms: 0,
    ack: async () => {
      m.acks++;
    },
    nak: (d?: number) => {
      m.naks.push(d ?? 0);
    },
    term: () => {
      m.terms++;
    },
    working: () => {},
  };
  return m as DeliveredMessage & typeof m;
}
let paused = false;
const worker = (extra: Partial<ConstructorParameters<typeof PublisherWorker>[0]> = {}) =>
  new PublisherWorker({
    artifacts,
    operations,
    destination: new SubstackDestinationController(client),
    destinationName: "example-destination",
    owner: "publisher",
    paused: () => paused,
    retryDelayMs: 0,
    leaseMs: 1,
    now: () => clock,
    ...extra,
  });
const published = () => operations.duePendingEvents(10, ARTICLE_PUBLISHED_SUBJECT);

describe("PublisherWorker smoke test", () => {
  beforeEach(() => {
    paused = false;
  });

  it("publishes an approved artifact once, and treats duplicate input as already published", async () => {
    const event = await approved("p1");
    const m = message(event);
    const r = await worker().handle(m);
    expect(r).toMatchObject({
      kind: "published",
      receipt: { url: expect.stringContaining("https://destination.example/p/") },
    });
    expect(m.acks).toBe(1);
    expect(client.drafts.size).toBe(1);
    expect([...client.drafts.values()][0]!.emailed).toBe(false);
    expect(published()).toHaveLength(1);
    const again = message(event);
    expect(await worker().handle(again)).toMatchObject({ kind: "already-published" });
    expect(again.acks).toBe(1);
    expect(client.drafts.size).toBe(1);
    expect(published()).toHaveLength(1);
  });

  it("refuses a changed draft that the approval does not cover", async () => {
    const event = await approved("p1");
    // The bytes at the approved path change in a later commit; the event now points at them.
    const changed = await artifacts.write(
      "drafts/pub/p1/d-changed.md",
      "Original post: https://pub.substack.com/p/p1\n\nEdited after approval.\n",
    );
    const tampered = { ...event, data: { ...event.data, draft: reference(changed) } };
    expect(await worker().handle(message(tampered))).toEqual({
      kind: "rejected",
      reason: "stale-approval",
    });
    expect(client.drafts.size).toBe(0);
  });

  it("holds everything while paused, then publishes when resumed", async () => {
    const event = await approved("p1");
    paused = true;
    const m = message(event);
    expect(await worker().handle(m)).toEqual({ kind: "deferred", reason: "paused" });
    expect(m.acks).toBe(0);
    expect(client.drafts.size).toBe(0);
    paused = false;
    expect(await worker().handle(message(event))).toMatchObject({ kind: "published" });
  });

  it("settles a lost publish response by read-back without a second draft or publish", async () => {
    const event = await approved("p1");
    client.inject("publishDraft", "lost-response");
    const first = message(event);
    expect(await worker().handle(first)).toEqual({ kind: "deferred", reason: "uncertain" });
    expect(first.acks).toBe(0);
    expect(
      operations.publicationState(
        `publish:example-destination:drafts:${event.data.draft.commit}:${event.data.draft.path}`,
      ),
    ).toMatchObject({ status: "uncertain" });
    const second = message(event);
    expect(await worker().handle(second)).toMatchObject({ kind: "published" });
    expect(second.acks).toBe(1);
    expect(client.drafts.size).toBe(1);
    expect(published()).toHaveLength(1);
  });

  it("applies the frequency limit between publications", async () => {
    const w = worker({ minIntervalMs: 60 * 60_000 });
    expect(await w.handle(message(await approved("p1")))).toMatchObject({ kind: "published" });
    const next = message(await approved("p2"));
    expect(await w.handle(next)).toEqual({ kind: "deferred", reason: "rate-limited" });
    expect(next.naks[0]).toBeGreaterThan(0);
    clock = new Date(clock.getTime() + 61 * 60_000);
    expect(await w.handle(message(await approved("p2")))).toMatchObject({ kind: "published" });
  });

  it("keeps backfill publication disabled and acknowledges non-approvals", async () => {
    const backfill = message(await approved("p1", "Backfilled.", "backfill"));
    expect(await worker().handle(backfill)).toEqual({
      kind: "rejected",
      reason: "backfill-disabled",
    });
    expect(backfill.acks).toBe(1);
    const redraft = await approved("p2");
    const m = message({ ...redraft, data: { ...redraft.data, verdict: "redraft" } });
    expect(await worker().handle(m)).toEqual({ kind: "rejected", reason: "not-approved" });
    expect(client.drafts.size).toBe(0);
  });

  it("stops visibly on uncertain draft creation instead of retrying blindly", async () => {
    const event = await approved("p1");
    client.inject("createDraft", "outage");
    const m = message(event);
    expect(await worker().handle(m)).toEqual({ kind: "failed", reason: "uncertain-creation" });
    expect(m.acks).toBe(1);
    expect(await worker().handle(message(event))).toMatchObject({ kind: "failed" });
    expect(client.drafts.size).toBe(0);
  });

  it("retries a rate limit and terminates malformed input", async () => {
    const event = await approved("p1");
    client.inject("createDraft", "rate-limited");
    expect(await worker().handle(message(event))).toEqual({ kind: "deferred", reason: "retry" });
    expect(await worker().handle(message(event))).toMatchObject({ kind: "published" });
    expect(client.drafts.size).toBe(1);
    const bad = message({});
    expect(await worker().handle(bad)).toEqual({ kind: "rejected", reason: "malformed-event" });
    expect(bad.terms).toBe(1);
  });
});
