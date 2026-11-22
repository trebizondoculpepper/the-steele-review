import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { researchJobId } from "../../src/research/job.js";
import type { CommissionedJob } from "../../src/research/librarian.js";
import {
  restateResearchIngress,
  submitManualResearch,
  type ResearchIngressPort,
} from "../../src/research/research-submission.js";

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-submit-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const request = {
  schemaVersion: 1 as const,
  origin: "manual" as const,
  subject: "Mast safety",
  pass: 1,
  claims: [],
  corpusRefs: [],
};

/** A Restate-like ingress: one invocation per (handler, idempotency key). */
function fakeIngress(finish?: () => Promise<CommissionedJob>) {
  const invocations = new Map<string, string>();
  const sent: Array<{ handler: string; key: string }> = [];
  let cancelled = 0;
  const port: ResearchIngressPort = {
    async send(handler, _request, key) {
      sent.push({ handler, key });
      const k = `${handler}/${key}`;
      const known = invocations.get(k);
      if (known) return { invocationId: known, status: "PreviouslyAccepted" };
      const id = `inv_${"a".repeat(10)}${invocations.size}`;
      invocations.set(k, id);
      return { invocationId: id, status: "Accepted" };
    },
    async attach(_id, signal) {
      if (!finish) {
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("wait-timeout")), { once: true }),
        );
      }
      return finish();
    },
  };
  return { port, sent, invocations, cancelled: () => cancelled };
}

describe("manual research submission (#594)", { timeout: 30_000 }, () => {
  it("submits once and returns durable identifiers; a repeat attaches to the same invocation", async () => {
    const ingress = fakeIngress();
    const first = await submitManualResearch({
      ingress: ingress.port,
      request,
      staged: false,
    });
    expect(first).toMatchObject({
      kind: "submitted",
      jobId: researchJobId(request),
      repeated: false,
      handler: "run",
    });
    const again = await submitManualResearch({
      ingress: ingress.port,
      request,
      staged: false,
    });
    expect(again).toMatchObject({ kind: "submitted", repeated: true });
    expect(again.kind === "submitted" && first.kind === "submitted" && again.invocationId).toBe(
      first.kind === "submitted" ? first.invocationId : "",
    );
    // One invocation: no duplicate paid discovery.
    expect(ingress.invocations.size).toBe(1);
    // The same stable call key article research uses.
    expect(ingress.sent[0]!.key).toBe(researchJobId(request));
  });

  it("uses the staged contract when new runs are staged", async () => {
    const ingress = fakeIngress();
    const out = await submitManualResearch({
      ingress: ingress.port,
      request,
      staged: true,
    });
    expect(out).toMatchObject({ handler: "runStaged" });
  });

  it("hands saved work to the worker under its own key, and reprocesses as a new linked job", async () => {
    const jobId = researchJobId(request);
    await artifacts.write(
      `research-jobs/${jobId}/result.json`,
      JSON.stringify({
        schemaVersion: 1,
        jobId,
        outcome: "failed",
        failure: "provider-error",
        finishedAt: "2026-11-20T00:00:00.000Z",
      }),
    );
    const ingress = fakeIngress();
    const out = await submitManualResearch({
      ingress: ingress.port,
      request,
      staged: false,
    });
    // Submitted under the original job's key: the worker reuses the saved
    // result (repairing any missing completion event) without new discovery.
    expect(out).toMatchObject({ kind: "submitted", jobId });
    expect(ingress.sent[0]!.key).toBe(jobId);
    // Explicit reprocessing submits under a distinct, stable key.
    const re = await submitManualResearch({
      ingress: ingress.port,
      request,
      staged: false,
      reprocess: 1,
    });
    expect(re).toMatchObject({ kind: "submitted" });
    // A new durable job: a later pass linked to the original, never the old job's key.
    const reJobId = researchJobId({ ...request, pass: 2, previousJobId: jobId });
    expect(re).toMatchObject({ jobId: reJobId });
    expect(ingress.sent[1]!.key).toBe(reJobId);
    // The original result is untouched.
    expect(await artifacts.lookup(`research-jobs/${jobId}/result.json`)).toBeDefined();
  });

  it("waits for the finished job when asked", async () => {
    const jobId = researchJobId(request);
    const ingress = fakeIngress(async () => ({ jobId, status: "finished" }));
    const out = await submitManualResearch({
      ingress: ingress.port,
      request,
      staged: false,
      waitMs: 5_000,
    });
    expect(out).toMatchObject({ kind: "submitted", job: { jobId, status: "finished" } });
  });

  it("ends a wait without cancelling: the invocation keeps running and can be reattached", async () => {
    const ingress = fakeIngress();
    const out = await submitManualResearch({
      ingress: ingress.port,
      request,
      staged: false,
      waitMs: 1_000,
    });
    expect(out).toMatchObject({ kind: "submitted", waitEnded: "timeout" });
    expect(ingress.cancelled()).toBe(0);
    // Recovery after disconnect: resubmitting attaches to the same invocation.
    const again = await submitManualResearch({
      ingress: ingress.port,
      request,
      staged: false,
    });
    expect(again).toMatchObject({ repeated: true });
    expect(ingress.invocations.size).toBe(1);
  });
});

describe("restate research ingress adapter (#594)", { timeout: 15_000 }, () => {
  it("aborts the attachment request when the wait ends, without hanging", async () => {
    const sockets = new Set<import("node:net").Socket>();
    let attached = "";
    const server = createServer((req) => {
      attached = req.url ?? "";
      // Never answer: a long-running job.
    });
    server.on("connection", (s) => sockets.add(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      const started = Date.now();
      await expect(
        restateResearchIngress(`http://127.0.0.1:${port}`).attach(
          "inv_abcdefghij1",
          AbortSignal.timeout(200),
        ),
      ).rejects.toThrow("wait-timeout");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(attached).toBe("/restate/invocation/inv_abcdefghij1/attach");
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("attach response validation (#594)", { timeout: 15_000 }, () => {
  it("rejects a malformed job from the ingress", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      await expect(
        restateResearchIngress(`http://127.0.0.1:${port}`).attach(
          "inv_abcdefghij1",
          AbortSignal.timeout(5_000),
        ),
      ).rejects.toThrow("invalid job");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
