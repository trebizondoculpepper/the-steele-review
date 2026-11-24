import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  createCapturedContentEvent,
  substackCapturedContent,
} from "../../src/events/captured-content-event.js";
import {
  candidatesFromSubmissionPaths,
  candidatesFromWorkflowKeys,
  reconcileAdmissions,
} from "../../src/workflow/admission-reconcile.js";
import { handleCapturedContent } from "../../src/workflow/captured-bridge.js";

// #874: a real state database and the real bridge; the submitter admits one
// workflow per key, as Restate does. No network, Restate or model calls.
const rev = (c: string) => `sha256:${c.repeat(64)}`;
let dir: string;
let stores: OperationStore[];
const store = () => {
  const s = new OperationStore({ path: join(dir, "bridge.sqlite") });
  stores.push(s);
  return s;
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "admission-"));
  stores = [];
});
afterEach(async () => {
  for (const s of stores) s.close();
  await rm(dir, { recursive: true, force: true });
});

const event = (postId: string, sourceVersion: string) =>
  JSON.stringify(
    createCapturedContentEvent(
      substackCapturedContent({
        artifact: {
          repository: "archive",
          commit: "a".repeat(40),
          path: `substack/example-pub/${postId}/source.json`,
          hash: `sha256:${sourceVersion.slice(7, 8).repeat(64)}`,
        },
        record: {
          item: { publicationId: "example-pub", postId, url: `https://x.example/p/${postId}` },
          ingestionReason: "live",
          complete: true,
          provenance: { method: "article-html" },
        },
        sourceVersion,
      }),
    ).toJSON(),
  );

function bridge(operations: OperationStore, failSubmits = 0) {
  const runs = new Set<string>();
  let failures = failSubmits;
  const deliver = (payload: string) =>
    handleCapturedContent(payload, {
      enabledSources: new Set(["substack/example-pub"]),
      researchDeadlineMs: 60_000,
      retryDelayMs: 0,
      admit: (post) => operations.admitAutomaticArticle(post),
      submit: async (key) => {
        if (failures-- > 0) throw new Error("synthetic Restate outage");
        if (runs.has(key)) return "already-running";
        runs.add(key);
        return "started";
      },
    });
  return { runs, deliver };
}

describe("one automatic article run per post (#874)", () => {
  it("admits a repeated revision once, refuses an edit, and admits a new post", async () => {
    const b = bridge(store());
    expect(await b.deliver(event("one", rev("a")))).toMatchObject({ outcome: "started" });
    // A repeated poll or resend of the same revision reattaches.
    expect(await b.deliver(event("one", rev("a")))).toMatchObject({ outcome: "already-running" });
    // An edit to the same post updates its source but starts no second run.
    expect(await b.deliver(event("one", rev("b")))).toMatchObject({
      outcome: "skipped",
      reason: "already-admitted",
    });
    expect(await b.deliver(event("two", rev("c")))).toMatchObject({ outcome: "started" });
    expect(b.runs.size).toBe(2);
  });

  it("admits exactly one revision when two processes discover the same post", async () => {
    const first = store();
    const second = store();
    const a = first.admitAutomaticArticle({
      publicationId: "example-pub",
      postId: "one",
      sourceVersion: rev("a"),
    });
    const b = second.admitAutomaticArticle({
      publicationId: "example-pub",
      postId: "one",
      sourceVersion: rev("b"),
    });
    expect([a.admitted, b.admitted]).toEqual([true, false]);
    expect(b.admission.revision).toBe("a".repeat(32));
  });

  it("retries a submission that failed before acknowledgement without a second run", async () => {
    const b = bridge(store(), 1);
    expect(await b.deliver(event("one", rev("a")))).toMatchObject({ action: "nak" });
    expect(await b.deliver(event("one", rev("a")))).toMatchObject({ outcome: "started" });
    expect(await b.deliver(event("one", rev("a")))).toMatchObject({ outcome: "already-running" });
    expect(b.runs.size).toBe(1);
  });

  it("keeps an explicit rerun on its own stable request ID", () => {
    const s = store();
    s.admitAutomaticArticle({
      publicationId: "example-pub",
      postId: "one",
      sourceVersion: rev("a"),
    });
    const rerun = {
      publicationId: "example-pub",
      postId: "one",
      sourceVersion: rev("b"),
      requestId: "owner-rerun-1",
      inputHash: "e".repeat(64),
    };
    const first = s.recordArticleAttempt(rerun);
    // Retrying the same request gives the same workflow, so one paid run.
    expect(s.recordArticleAttempt(rerun).workflowKey).toBe(first.workflowKey);
    expect(first.workflowKey).toMatch(/~run-/);
  });

  it("does not replay posts processed before the switch", async () => {
    const s = store();
    // Processed before admission by post existed: a recorded capture intent.
    s.recordCapturedArticleIntent({
      publicationId: "example-pub",
      postId: "old",
      sourceVersion: rev("a"),
      inputHash: "f".repeat(64),
      input: {
        repository: "content",
        commit: "c".repeat(40),
        path: "article-submissions/x.json",
        hash: rev("d"),
      },
    });
    // And posts known only from Restate's records and the submission archive.
    const candidates = [
      ...candidatesFromWorkflowKeys([
        "example-pub/older@" + "b".repeat(32) + "~run-abc",
        "not-a-key",
      ]),
      ...candidatesFromSubmissionPaths([
        `article-submissions/example-pub/oldest/${"c".repeat(64)}/${"d".repeat(64)}.json`,
      ]),
    ];
    expect(reconcileAdmissions(s, candidates, { apply: false })).toEqual({
      posts: 2,
      recorded: 2,
      alreadyAdmitted: 0,
    });
    expect(s.automaticAdmission("example-pub", "older")).toBeUndefined(); // dry run wrote nothing
    expect(reconcileAdmissions(s, candidates, { apply: true })).toMatchObject({ recorded: 2 });
    expect(reconcileAdmissions(s, candidates, { apply: true })).toMatchObject({
      recorded: 0,
      alreadyAdmitted: 2,
    });

    const b = bridge(s);
    // Edited or re-announced old posts start nothing new...
    for (const [post, r] of [
      ["old", "e"],
      ["older", "e"],
      ["oldest", "e"],
    ] as const)
      expect(await b.deliver(event(post, rev(r)))).toMatchObject({ reason: "already-admitted" });
    // ...while the revision each already ran reattaches rather than refusing.
    expect(await b.deliver(event("old", rev("a")))).toMatchObject({ outcome: "started" });
    expect(s.automaticAdmission("example-pub", "old")?.basis).toBe("prior-intent");
    expect(s.automaticAdmission("example-pub", "older")?.basis).toBe("reconciled");
  });

  it("starts no base run for a post known only from an explicit rerun", async () => {
    const s = store();
    reconcileAdmissions(
      s,
      candidatesFromWorkflowKeys([`example-pub/rerun-only@${"a".repeat(32)}~run-abc`]),
      { apply: true },
    );
    expect(s.automaticAdmission("example-pub", "rerun-only")?.workflowKey).toMatch(/~run-abc$/);
    const b = bridge(s);
    // Even the same revision is refused: the base run never ran and must not start now.
    expect(await b.deliver(event("rerun-only", rev("a")))).toMatchObject({
      reason: "already-admitted",
    });
    expect(b.runs.size).toBe(0);
  });

  it("reports an unreachable Restate by category only", async () => {
    const { articleRunKeys, RestateAdminError } =
      await import("../../src/controllers/restate-admin.js");
    const failing = (async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.9:9070");
    }) as typeof fetch;
    const error = await articleRunKeys("http://admin.example.test:9070", { fetch: failing }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RestateAdminError);
    expect(String((error as Error).message)).toBe("restate admin unreachable");
    expect(JSON.stringify(error)).not.toMatch(/10\.0\.0\.9|admin\.example/);
  });
});
