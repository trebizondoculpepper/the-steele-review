import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { researchJobId } from "../../src/research/job.js";
import type { CommissionedJob } from "../../src/research/librarian.js";
import {
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
      artifacts,
      request,
      staged: false,
      inspect: (id) => `https://restate.invalid/ui/invocations/${id}`,
    });
    expect(first).toMatchObject({
      kind: "submitted",
      jobId: researchJobId(request),
      repeated: false,
      handler: "run",
    });
    expect(first.kind === "submitted" && first.inspect).toMatch(/invocations\/inv_/);
    const again = await submitManualResearch({
      ingress: ingress.port,
      artifacts,
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
      artifacts,
      request,
      staged: true,
    });
    expect(out).toMatchObject({ handler: "runStaged" });
  });

  it("reports saved work instead of resubmitting it, including legacy standalone results", async () => {
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
      artifacts,
      request,
      staged: false,
    });
    expect(out).toMatchObject({ kind: "existing", result: { outcome: "failed" } });
    expect(ingress.sent).toHaveLength(0);
    // Explicit reprocessing submits under a distinct, stable key.
    const re = await submitManualResearch({
      ingress: ingress.port,
      artifacts,
      request,
      staged: false,
      reprocess: 1,
    });
    expect(re).toMatchObject({ kind: "submitted" });
    expect(ingress.sent[0]!.key).toBe(`${jobId}:recovery-1`);
  });

  it("waits for the finished job when asked", async () => {
    const jobId = researchJobId(request);
    const ingress = fakeIngress(async () => ({ jobId, status: "finished" }));
    const out = await submitManualResearch({
      ingress: ingress.port,
      artifacts,
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
      artifacts,
      request,
      staged: false,
      waitMs: 1_000,
    });
    expect(out).toMatchObject({ kind: "submitted", waitEnded: "timeout" });
    expect(ingress.cancelled()).toBe(0);
    // Recovery after disconnect: resubmitting attaches to the same invocation.
    const again = await submitManualResearch({
      ingress: ingress.port,
      artifacts,
      request,
      staged: false,
    });
    expect(again).toMatchObject({ repeated: true });
    expect(ingress.invocations.size).toBe(1);
  });
});
