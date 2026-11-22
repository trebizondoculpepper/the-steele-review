import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment, RestateContainer } from "@restatedev/restate-sdk-testcontainers";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vite-plus/test";
import { GitArtifactStore, ArtifactStoreError } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  restateRecoveryParentCompletion,
  restateJudgeRecovery,
} from "../../src/controllers/editorial-recovery-ingress.js";
import { prepareJudgeRecovery } from "../../src/workflow/editorial-judge-recovery-submission.js";
import {
  editorialJudgeRecoveryWorkflow,
  reconcileJudgeRecoveryApproval,
} from "../../src/workflow/editorial-judge-recovery.js";
import { editorialStages } from "../../src/workflow/editorial-stages.js";
import { artifactRef } from "../../src/drafting/publication-payload.js";
import { deniedContinuationFixture } from "./editorial-recovery-fixtures.js";
import { APPROVE, REVISE } from "./editorial-continuation-fixtures.js";
import {
  handleApprovedArticle,
  readDummyDeliveryProof,
  SimulatedDestination,
} from "../../src/publishing/approved-article.js";
import { WRITER } from "../publishing/approval-fixtures.js";
let dir: string, content: GitArtifactStore, operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "judge-recovery-flow-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
const window = { version: "editorial-recovery-window-v1" as const, deadlineMs: 120000 };
async function start(
  options: {
    spent?: number;
    decisions?: string[];
    approvalLost?: boolean;
    metadataOnly?: boolean;
    crashManifest?: boolean;
    innerFailure?: boolean;
    liveExpired?: boolean;
    wrongModel?: boolean;
    window?: typeof window;
    judgeDelay?: number;
  } = {},
) {
  const f = await deniedContinuationFixture(
    content,
    operations,
    options.spent ?? 1,
    false,
    options.metadataOnly,
  );
  const calls = { writer: 0, assessor: 0, judge: 0, approve: 0 };
  const configuredWindow = { ...(options.window ?? window) };
  let storageFailed = false;
  const runtimeContent = new Proxy(content, {
    get(target, key) {
      if (key === "write")
        return async (...args: Parameters<GitArtifactStore["write"]>) => {
          if (
            options.crashManifest &&
            !storageFailed &&
            args[0].startsWith("editorial-attempts/") &&
            args[0].endsWith("/manifest.json")
          ) {
            storageFailed = true;
            throw new ArtifactStoreError("git-failed");
          }
          if (options.innerFailure && args[0].startsWith("editorial-judge-recovery-loops/"))
            throw new Error("synthetic inner summary unavailable");
          return target.write(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const actual = editorialStages({
    content: runtimeContent,
    archive: f.parent.archive,
    operations,
    writer: {
      modelVersion: "synthetic/writer",
      complete: async () => {
        calls.writer++;
        const out = JSON.parse(WRITER);
        out.title = "An exactly reviewed recovered article";
        out.responses[0].text =
          "The treaty prohibits hostile environmental modification. This response retains its exact source scope.";
        return JSON.stringify(out);
      },
    },
    assessor: {
      modelVersion: "synthetic/assessor",
      complete: async () => {
        calls.assessor++;
        return "No faults found.\nEND OF ASSESSMENT";
      },
    },
    judge: {
      modelVersion: "synthetic/judge",
      complete: async () => {
        const n = calls.judge++;
        if (options.judgeDelay)
          await new Promise((resolve) => setTimeout(resolve, options.judgeDelay));
        return (options.decisions ?? [APPROVE])[
          Math.min(n, (options.decisions ?? [APPROVE]).length - 1)
        ]!;
      },
    },
  });
  const stages = {
    ...actual,
    approve: async (...args: Parameters<typeof actual.approve>) => {
      calls.approve++;
      const out = await actual.approve(...args);
      if (options.approvalLost) throw new Error("synthetic lost acknowledgment");
      return out;
    },
  };
  const failed = {
    version: "editorial-continuation-result-v1",
    outcome: "failed",
    reason: "editorial judgment provider-failed",
    summary: artifactRef(f.request.parent.summary),
    draft: artifactRef(f.request.body),
    metadata: artifactRef(f.request.metadata),
    completedAt: f.raw.completedAt,
  };
  const Parent = restate.workflow({
    name: "EditorialContinuation",
    handlers: { run: async () => failed },
  });
  let parentPort: ReturnType<typeof restateRecoveryParentCompletion>;
  const Recovery = editorialJudgeRecoveryWorkflow({
    content: runtimeContent,
    archive: f.parent.archive,
    operations,
    stages,
    configuredWindow,
    ...(options.liveExpired ? { liveNow: () => Date.now() + 3600000 } : {}),
    currentJudge: { modelVersion: options.wrongModel ? "different/model" : "synthetic/judge" },
    parentCompletion: { read: (key) => parentPort.read(key) },
  });
  const env = await RestateTestEnvironment.start(
    { services: [Parent, Recovery], serviceEndpointAccess: "docker-host" },
    () => new RestateContainer("1.8.1"),
  );
  parentPort = restateRecoveryParentCompletion(env.baseUrl());
  const ingress = clients.connect({ url: env.baseUrl() }),
    parent = ingress.workflowClient(Parent, f.request.parent.workflowKey);
  await parent.workflowSubmit();
  await parent.workflowAttach();
  const prepare = (
    id = "recover-once",
    generation = 1,
    selectedWindow = options.window ?? window,
    selectedSeed = f.request,
  ) =>
    prepareJudgeRecovery({
      seed: selectedSeed,
      requestId: id,
      generation,
      window: selectedWindow,
      content,
      archive: f.parent.archive,
      operations,
      currentJudge: { modelVersion: "synthetic/judge" },
      parentCompletion: parentPort,
    });
  const submit = async () => {
    const p = await prepare(),
      client = ingress.workflowClient(Recovery, p.workflowKey);
    const adapter = restateJudgeRecovery(env.baseUrl());
    const receipt = await adapter.submit(p.workflowKey, p.input);
    return { p, client, adapter, receipt, result: await adapter.attach(p.workflowKey, 120000) };
  };
  return {
    f,
    calls,
    env,
    prepare,
    submit,
    changeWindow: (deadlineMs: number) => {
      configuredWindow.deadlineMs = deadlineMs;
    },
  };
}
describe("versioned judge-only recovery", { timeout: 240000 }, () => {
  it("judges the saved assessment once without repeating writer or assessor", async () => {
    const t = await start();
    try {
      const { result, adapter, receipt, p } = await t.submit();
      expect(receipt.invocationId).toMatch(/^inv_/);
      expect(receipt.repeated).toBe(false);
      expect(result.outcome).toBe("verified");
      expect(t.calls).toEqual({ writer: 0, assessor: 0, judge: 1, approve: 1 });
      expect(result.draft).toEqual(artifactRef(t.f.request.body));
      const saved = JSON.parse(await content.read(result.summary));
      expect(saved.newCounts).toEqual({
        revisionAttempts: 0,
        revisions: 0,
        assessments: 0,
        judgments: 1,
      });
      expect(saved.reusedAssessments).toEqual([artifactRef(t.f.request.assessment)]);
      expect(saved.remainingEditsAfter).toBe(1);
      expect((await adapter.submit(p.workflowKey, p.input)).repeated).toBe(true);
      expect((await adapter.attach(p.workflowKey, 120000)).approvalEvent).toBe(
        result.approvalEvent,
      );
      expect(t.calls.judge).toBe(1);
      const record = JSON.parse(await content.read(saved.editorial.judgments[0]));
      const capture = JSON.parse(await content.read(artifactRef(record.retainedAttempts[0])));
      const recoveredInput = JSON.parse(await content.read(artifactRef(capture.input))),
        originalInput = JSON.parse(await content.read(artifactRef(t.f.request.input)));
      expect(recoveredInput.context).toEqual(originalInput.context);
      expect(JSON.stringify(recoveredInput.request)).toBe(JSON.stringify(originalInput.request));
      expect(recoveredInput.recovery.previous).toEqual(t.f.request.capture);
      expect(result.metadata).toEqual(artifactRef(t.f.request.metadata));
      const pending = operations.pendingEvent(result.approvalEvent!)!;
      for (const name of ["dummy-a", "dummy-b"]) {
        const delivered = await handleApprovedArticle({
          payload: pending.payload,
          destination: new SimulatedDestination(name, "draft"),
          schedule: { delayMs: 0 },
          content,
          operations,
          owner: "synthetic-recovery-proof",
        });
        expect(delivered.action).toBe("ack");
      }
      expect(await readDummyDeliveryProof(content, JSON.parse(pending.payload).data)).toBeDefined();
    } finally {
      await t.env.stop();
    }
  });
  it("uses only the original remaining edit then fresh assessment and judgment", async () => {
    const t = await start({ decisions: [REVISE, APPROVE] });
    try {
      const { result } = await t.submit();
      expect(result.outcome).toBe("verified");
      expect(t.calls).toEqual({ writer: 1, assessor: 1, judge: 2, approve: 1 });
      const saved = JSON.parse(await content.read(result.summary));
      expect(saved.newCounts).toEqual({
        revisionAttempts: 1,
        revisions: 1,
        assessments: 1,
        judgments: 2,
      });
      expect(saved.remainingEditsAfter).toBe(0);
      expect(saved.totalContinuationEditAttempts).toBe(2);
    } finally {
      await t.env.stop();
    }
  });
  it.each([APPROVE, REVISE])("honors zero remaining edits with %s", async (decision) => {
    const t = await start({ spent: 2, decisions: [decision] });
    try {
      const { result } = await t.submit();
      expect(result.outcome).toBe(decision === APPROVE ? "verified" : "rejected");
      expect(t.calls.writer).toBe(0);
      expect(t.calls.assessor).toBe(0);
      expect(t.calls.judge).toBe(1);
      const saved = JSON.parse(await content.read(result.summary));
      expect(saved.remainingEditsAfter).toBe(0);
      expect(saved.newCounts.revisionAttempts).toBe(0);
    } finally {
      await t.env.stop();
    }
  });
  it("retains selected metadata-only pair without deriving older metadata from body commit", async () => {
    const t = await start({ metadataOnly: true });
    try {
      expect(t.f.request.body.commit).not.toBe(t.f.request.metadata.commit);
      const { result } = await t.submit();
      expect(result.outcome).toBe("verified");
      expect(result.draft).toEqual(artifactRef(t.f.request.body));
      expect(result.metadata).toEqual(artifactRef(t.f.request.metadata));
      expect(t.calls.writer).toBe(0);
      expect(t.calls.assessor).toBe(0);
    } finally {
      await t.env.stop();
    }
  });
  it("reserves one task across competing generations and reconnects frozen intent after its own edit", async () => {
    const t = await start({ decisions: [REVISE, APPROVE] });
    try {
      const p = await t.prepare();
      await expect(t.prepare("competing", 2)).rejects.toThrow("invalid-input");
      t.changeWindow(180000);
      const { result } = await t.submit();
      expect(result.outcome).toBe("verified");
      const again = await t.prepare("recover-once", 1, { ...window, deadlineMs: 300000 });
      expect(again.repeatedIntent).toBe(true);
      expect(again.input).toEqual(p.input);
      expect(again.intent.window.deadlineMs).toBe(window.deadlineMs);
      const changed = structuredClone(t.f.request);
      changed.body.hash = `sha256:${"0".repeat(64)}`;
      await expect(t.prepare("recover-once", 1, window, changed)).rejects.toThrow(
        "identity-conflict",
      );
      expect(t.calls).toEqual({ writer: 1, assessor: 1, judge: 2, approve: 1 });
    } finally {
      await t.env.stop();
    }
  });
  it.each(["manifest", "approval", "summary"])(
    "preserves exact paid outcomes across %s interruption",
    async (mode) => {
      const t = await start({
        crashManifest: mode === "manifest",
        approvalLost: mode === "approval",
        innerFailure: mode === "summary",
      });
      try {
        const { result } = await t.submit();
        expect(result.outcome).toBe("verified");
        expect(t.calls.judge).toBe(1);
        expect(t.calls.writer).toBe(0);
        expect(t.calls.assessor).toBe(0);
        const saved = JSON.parse(await content.read(result.summary));
        expect(saved.newCounts).toEqual({
          revisionAttempts: 0,
          revisions: 0,
          assessments: 0,
          judgments: 1,
        });
        expect(saved.approvalState).toBe("recorded");
        expect(operations.pendingEvent(result.approvalEvent!)).toBeDefined();
        if (mode === "summary") expect(saved.editorialSummaryUnavailable).toBe(true);
        const judgments = (saved.editorial ?? saved.partialEditorial).judgments;
        const mismatched = await reconcileJudgeRecoveryApproval({
          content,
          operations,
          judgment: judgments.at(-1),
          version: {
            draft: result.draft!,
            metadata: { ...result.metadata!, commit: "f".repeat(40) },
          },
          package: artifactRef(t.f.request.package),
          post: { publicationId: "pub", postId: "p1" },
        });
        expect(mismatched.state).toBe("unknown");
      } finally {
        await t.env.stop();
      }
    },
  );
  it("stops an expired live dispatch guard without any new provider call", async () => {
    const t = await start({ liveExpired: true });
    try {
      const { result } = await t.submit();
      expect(result.outcome).toBe("failed");
      expect(result.reason).toBe("recovery-deadline");
      expect(t.calls).toEqual({ writer: 0, assessor: 0, judge: 0, approve: 0 });
      const saved = JSON.parse(await content.read(result.summary));
      expect(saved.newCounts).toEqual({
        revisionAttempts: 0,
        revisions: 0,
        assessments: 0,
        judgments: 0,
      });
    } finally {
      await t.env.stop();
    }
  });
  it("stops before approval when the window expires after a returned judgment", async () => {
    const t = await start({ window: { ...window, deadlineMs: 15000 }, judgeDelay: 15100 });
    try {
      const { result } = await t.submit();
      expect(result.outcome).toBe("failed");
      expect(result.reason).toBe("editorial deadline reached");
      expect(t.calls).toEqual({ writer: 0, assessor: 0, judge: 1, approve: 0 });
      const saved = JSON.parse(await content.read(result.summary));
      expect(saved.newCounts.judgments).toBe(1);
      expect(saved.approvalState).toBe("absent");
    } finally {
      await t.env.stop();
    }
  });
  it("refuses changed configured task before any new model call", async () => {
    const t = await start({ wrongModel: true });
    try {
      const { result } = await t.submit();
      expect(result.outcome).toBe("skipped");
      expect(result.reason).toBe("task-mismatch");
      expect(t.calls).toEqual({ writer: 0, assessor: 0, judge: 0, approve: 0 });
    } finally {
      await t.env.stop();
    }
  });
  it("refuses a stale canonical base after intent recording", async () => {
    const t = await start();
    try {
      const p = await t.prepare();
      await content.revise(
        t.f.request.body.path,
        "A separately edited canonical article.",
        t.f.request.body.hash.slice(7),
      );
      const adapter = restateJudgeRecovery(t.env.baseUrl());
      await adapter.submit(p.workflowKey, p.input);
      const result = await adapter.attach(p.workflowKey, 120000);
      expect(result.outcome).toBe("skipped");
      expect(result.reason).toBe("stale-base");
      expect(t.calls).toEqual({ writer: 0, assessor: 0, judge: 0, approve: 0 });
    } finally {
      await t.env.stop();
    }
  });
});
