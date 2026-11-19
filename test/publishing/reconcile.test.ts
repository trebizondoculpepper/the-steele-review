import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { OperationStore, type OperationClaim } from "../../src/controllers/operation-store.js";
import { ControlledSubstackClient } from "../../src/publishing/controlled-destination.js";
import { SubstackDestinationController } from "../../src/publishing/destination.js";
import { reconcileUncertainPublication } from "../../src/publishing/reconcile.js";

const KEY = "publish:substack/example-pub/a-post";
const artifact = { hash: `sha256:${"a".repeat(64)}`, ref: { path: "drafts/a.md" } };
const content = {
  title: "A synthetic response",
  bodyMarkdown: "Synthetic body.",
  sourceUrl: "https://example-pub.substack.com/p/a-post",
};

let dir: string;
let ops: OperationStore;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-reconcile-"));
  clock = Date.parse("2026-05-01T12:00:00Z");
  ops = new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock });
});
afterEach(async () => {
  ops.close();
  await rm(dir, { recursive: true, force: true });
});

function destination() {
  const client = new ControlledSubstackClient("https://destination.example", () => new Date(clock));
  return { client, destination: new SubstackDestinationController(client) };
}

/** Publisher that created and saved a draft, then lost the publish response and crashed. */
async function lostResponse(
  dest: ReturnType<typeof destination>,
  options: { publishHappened: boolean; maxAttempts?: number } = { publishHappened: true },
) {
  const claimed = ops.claim(KEY, "publisher-1", 1_000, options.maxAttempts ?? 5);
  if (claimed.kind !== "claimed") throw new Error("expected claim");
  const claim: OperationClaim = claimed.claim;
  ops.recordPublicationIntent(claim, artifact);
  const { draftId } = await dest.destination.createDraft(content);
  ops.saveDestinationDraft(claim, draftId);
  if (options.publishHappened) dest.client.inject("publishDraft", "lost-response");
  else dest.client.inject("publishDraft", "outage");
  await expect(dest.destination.publish(draftId)).rejects.toMatchObject({ category: "uncertain" });
  ops.markPublicationUncertain(claim);
  clock += 1_001; // the publisher's lease expires
  return { draftId };
}

const run = (
  dest: ReturnType<typeof destination>,
  extra: Partial<Parameters<typeof reconcileUncertainPublication>[0]> = {},
) =>
  reconcileUncertainPublication({
    operations: ops,
    destination: dest.destination,
    key: KEY,
    owner: "reconciler",
    sleep: async () => {},
    ...extra,
  });

describe("reconcileUncertainPublication", () => {
  it("confirms a publish whose response was lost, without a second draft or publish", async () => {
    const dest = destination();
    const { draftId } = await lostResponse(dest);
    const handed: string[] = [];
    const outcome = await run(dest, {
      eventsFor: (receipt) => {
        handed.push(receipt.url);
        return [{ eventId: "published-1", subject: "steele.v1.article.published", payload: "{}" }];
      },
    });
    expect(outcome).toMatchObject({ status: "published", receipt: { destinationPostId: draftId } });
    expect(ops.publicationState(KEY)).toMatchObject({
      status: "published",
      destinationDraftId: draftId,
    });
    expect(dest.client.drafts.size).toBe(1);
    expect(handed).toHaveLength(1);
    expect(ops.duePendingEvents().map((e) => e.eventId)).toEqual(["published-1"]);
    // Running again is a no-op.
    expect((await run(dest)).status).toBe("already-published");
  });

  it("recovers the handoff after a crash between confirmation and completion", async () => {
    const dest = destination();
    await lostResponse(dest);
    // Simulate the crash: confirmation committed, completion and events never did.
    const claimed = ops.claimForReconciliation(KEY, "crashed", 1);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    ops.confirmPublished(claimed.claim, {
      url: "https://destination.example/p/post-1000",
      publishedAt: "2026-05-01T12:00:01.000Z",
    });
    clock += 2;
    const outcome = await run(dest, {
      eventsFor: () => [
        { eventId: "published-1", subject: "steele.v1.article.published", payload: "{}" },
      ],
    });
    expect(outcome.status).toBe("already-published");
    expect(ops.duePendingEvents().map((e) => e.eventId)).toEqual(["published-1"]);
    expect(ops.claim(KEY, "x", 1_000).kind).toBe("completed");
    // Nothing more to do afterwards.
    expect((await run(dest)).status).toBe("already-published");
    expect(ops.duePendingEvents()).toHaveLength(1);
  });

  it("records a known unpublished draft and hands the claim back for a safe retry", async () => {
    const dest = destination();
    const { draftId } = await lostResponse(dest, { publishHappened: false });
    const outcome = await run(dest);
    expect(outcome).toMatchObject({ status: "unpublished", draftId });
    expect(ops.publicationState(KEY)?.status).toBe("unpublished");
    // The publisher can now publish the same draft under the returned claim.
    if (outcome.status !== "unpublished") throw new Error("expected unpublished");
    const receipt = await dest.destination.publish(outcome.draftId);
    ops.confirmPublished(outcome.claim, { url: receipt.url, publishedAt: receipt.publishedAt });
    expect(dest.client.drafts.size).toBe(1);
  });

  it("stays uncertain during a read-back outage, after bounded attempts, and releases the claim", async () => {
    const dest = destination();
    await lostResponse(dest);
    dest.client.inject("getDraft", "outage", "outage", "outage");
    expect(await run(dest, { maxReadAttempts: 3 })).toEqual({ status: "still-uncertain" });
    expect(ops.publicationState(KEY)?.status).toBe("uncertain");
    // A later attempt succeeds once the destination is back.
    expect((await run(dest)).status).toBe("published");
  });

  it("treats a conflicting read-back (another draft's identity) as unresolved", async () => {
    const dest = destination();
    await lostResponse(dest);
    const conflicting = new SubstackDestinationController({
      createDraft: async () => ({ id: 1 }),
      getDraft: async () => ({
        id: 99999,
        is_published: true,
        canonical_url: "https://other.example/p/x",
        post_date: "2026-05-01T12:00:00Z",
      }),
      publishDraft: async () => ({}),
    });
    expect(
      await reconcileUncertainPublication({
        operations: ops,
        destination: conflicting,
        key: KEY,
        owner: "r",
        maxReadAttempts: 2,
        sleep: async () => {},
      }),
    ).toEqual({ status: "still-uncertain" });
    expect(ops.publicationState(KEY)?.status).toBe("uncertain");
  });

  it("leaves a missing draft for an operator instead of creating a replacement", async () => {
    const dest = destination();
    const { draftId } = await lostResponse(dest);
    dest.client.drafts.delete(draftId);
    expect(await run(dest)).toEqual({ status: "draft-missing" });
    expect(dest.client.drafts.size).toBe(0);
    expect(ops.publicationState(KEY)?.status).toBe("uncertain");
  });

  it("works even when the publisher's final attempt lost the response", async () => {
    const dest = destination();
    await lostResponse(dest, { publishHappened: true, maxAttempts: 1 });
    expect(ops.claim(KEY, "publisher-2", 1_000, 1).kind).toBe("exhausted");
    expect((await run(dest)).status).toBe("published");
  });

  it("refuses to reconcile without a stored destination draft", async () => {
    const dest = destination();
    expect(await run(dest)).toEqual({ status: "not-reconcilable", reason: "no-publication" });
    const claimed = ops.claim(KEY, "p", 1_000);
    if (claimed.kind !== "claimed") throw new Error("expected claim");
    ops.recordPublicationIntent(claimed.claim, artifact);
    expect(await run(dest)).toEqual({ status: "not-reconcilable", reason: "no-destination-draft" });
  });

  it("respects a live lease and cancellation", async () => {
    const dest = destination();
    await lostResponse(dest);
    ops.claimForReconciliation(KEY, "someone-else", 60_000);
    expect(await run(dest)).toEqual({ status: "busy" });
    clock += 60_001;
    const abort = new AbortController();
    abort.abort();
    expect(await run(dest, { signal: abort.signal })).toEqual({ status: "cancelled" });
  });
});
