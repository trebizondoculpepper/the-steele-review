import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment, RestateContainer } from "@restatedev/restate-sdk-testcontainers";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vite-plus/test";
import { GitArtifactStore, ArtifactStoreError } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  restateParentCompletion,
  restateEditorialContinuation,
  type ParentCompletionPort,
} from "../../src/controllers/editorial-continuation-ingress.js";
import { editorialContinuationWorkflow } from "../../src/workflow/editorial-continuation.js";
import { prepareEditorialContinuation } from "../../src/workflow/editorial-continuation-submission.js";
import { editorialStages } from "../../src/workflow/editorial-stages.js";
import { artifactRef } from "../../src/drafting/publication-payload.js";
import { ARTICLE_APPROVED_SUBJECT } from "../../src/events/article-approved-event.js";
import {
  handleApprovedArticle,
  readDummyDeliveryProof,
  SimulatedDestination,
} from "../../src/publishing/approved-article.js";
import { continuationParentFixture, REVISE, APPROVE } from "./editorial-continuation-fixtures.js";
import { WRITER } from "../publishing/approval-fixtures.js";
import type { EditorialPolicy, EditorialStages } from "../../src/workflow/editorial-contract.js";
let dir: string, content: GitArtifactStore, operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-continuation-flow-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
const policy: EditorialPolicy = {
  version: "assess-judge-v1",
  maxRevisions: 2,
  deadlineMs: 120_000,
};
async function start(
  options: {
    parentRevisions?: number;
    decisions?: string[];
    crash?: "raw" | "commit" | "inner-summary";
    configured?: EditorialPolicy;
    parentStarted?: boolean;
  } = {},
) {
  const f = await continuationParentFixture(content, operations, options.parentRevisions ?? 0);
  const originalText = await content.read(f.version.draft);
  let writerCalls = 0,
    assessmentCalls = 0,
    judgmentCalls = 0;
  const order: string[] = [],
    writerRequests: any[] = [];
  const stages = editorialStages({
    content,
    operations,
    archive: f.archive,
    writer: {
      modelVersion: "fake/resume-writer",
      complete: async (request) => {
        order.push("revise");
        writerCalls++;
        const input = JSON.parse(request.user);
        writerRequests.push(input);
        expect(input.revision).toBeDefined();
        const out = JSON.parse(WRITER);
        out.title = `A narrower revised article ${writerCalls}`;
        out.responses[0].text = `The supplied treaty prohibits hostile environmental modification. This is a scoped account ${writerCalls}.`;
        return JSON.stringify(out);
      },
    },
    assessor: {
      modelVersion: "fake/resume-assessor",
      complete: async () => {
        order.push("assess");
        assessmentCalls++;
        return "No faults found.\nEND OF ASSESSMENT";
      },
    },
    judge: {
      modelVersion: "fake/resume-judge",
      complete: async () => {
        order.push("judge");
        return (options.decisions ?? [APPROVE])[
          Math.min(judgmentCalls++, (options.decisions ?? [APPROVE]).length - 1)
        ]!;
      },
    },
  });
  let crashed = false;
  const used: EditorialStages =
    options.crash === "commit"
      ? {
          ...stages,
          revise: async (...args) => {
            const out = await stages.revise(...args);
            if (!crashed && out.version) {
              crashed = true;
              throw new ArtifactStoreError("git-failed");
            }
            return out;
          },
        }
      : stages;
  if (options.crash === "raw" || options.crash === "inner-summary") {
    const write = content.write.bind(content);
    vi.spyOn(content, "write").mockImplementation(async (path, value, hash) => {
      if (
        options.crash === "raw" &&
        !crashed &&
        /^articles\/pub\/p1\/[a-f0-9]{32}\.md$/.test(path)
      ) {
        crashed = true;
        throw new ArtifactStoreError("git-failed");
      }
      if (options.crash === "inner-summary" && path.startsWith("editorial-continuation-loops/"))
        throw new ArtifactStoreError("git-failed");
      return write(path, value, hash);
    });
  }
  let parentPort: ParentCompletionPort;
  const Parent = restate.workflow({
    name: "ArticleRun",
    handlers: {
      run: async (_ctx: restate.WorkflowContext, _input: unknown) => ({
        outcome: "rejected",
        editorial: { summary: artifactRef(f.request.parent.summary) },
      }),
    },
  });
  const Continuation = editorialContinuationWorkflow({
    content,
    operations,
    archive: f.archive,
    stages: used,
    configuredPolicy: options.configured ?? policy,
    parentCompletion: { read: (key) => parentPort.read(key) },
  });
  const env = await RestateTestEnvironment.start(
    { services: [Parent, Continuation], serviceEndpointAccess: "docker-host" },
    () => new RestateContainer("1.8.1"),
  );
  parentPort = restateParentCompletion(env.baseUrl());
  const ingress = clients.connect({ url: env.baseUrl() });
  if (options.parentStarted !== false) {
    const parent = ingress.workflowClient(Parent, f.request.parent.workflowKey);
    await parent.workflowSubmit({});
    await parent.workflowAttach();
  }
  const prepare = (
    requestId: string,
    selectedPolicy = policy,
    selectedSeed = f.request,
    port = parentPort,
  ) =>
    prepareEditorialContinuation({
      seed: selectedSeed,
      requestId,
      policy: selectedPolicy,
      content,
      operations,
      archive: f.archive,
      parentCompletion: port,
    });
  const submit = async (requestId: string, selectedPolicy = policy) => {
    const p = await prepare(requestId, selectedPolicy);
    const w = ingress.workflowClient(Continuation, p.workflowKey);
    await w.workflowSubmit(p.input);
    return { p, w, result: await w.workflowAttach() };
  };
  return {
    f,
    env,
    ingress,
    Parent,
    Continuation,
    parentPort,
    prepare,
    submit,
    originalText,
    order,
    writerRequests,
    counts: () => ({ writerCalls, assessmentCalls, judgmentCalls }),
  };
}
describe("explicit bounded Restate editorial continuation", { timeout: 240_000 }, () => {
  it("starts with the exact saved-feedback edit, freshly approves its payload and proves both dummy destinations", async () => {
    const t = await start({ parentRevisions: 2 });
    try {
      const { result, w, p } = await t.submit("continue-once");
      expect(result.outcome).toBe("verified");
      expect(t.order).toEqual(["revise", "assess", "judge"]);
      expect(t.writerRequests[0].revision).toMatchObject({
        number: 1,
        previousDraft: t.originalText,
        previousDraftTruncated: false,
      });
      expect(t.writerRequests[0].revision.previousFields).toBeDefined();
      expect(t.writerRequests[0].revision.feedback[0].reason).toContain("Narrow the claim");
      expect(t.writerRequests[0].revision.nonBlockingObservations[0].reason).toContain(
        "supported tone",
      );
      const saved = JSON.parse(await content.read(result.summary));
      expect(saved.parentCounts).toEqual({ assessments: 3, judgments: 3, revisions: 2 });
      expect(saved.newCounts).toEqual({
        revisionAttempts: 1,
        revisions: 1,
        assessments: 1,
        judgments: 1,
      });
      expect(saved.mechanicalRuns).toHaveLength(1);
      expect(saved.retainedWriterAttempts.length).toBeGreaterThan(0);
      const metadata = JSON.parse(await content.read(result.metadata!));
      const capture = JSON.parse(await content.read(artifactRef(metadata.writerAttempts[0])));
      expect(capture.context).toContainEqual(p.input.intent);
      const pending = operations.pendingEvent(result.approvalEvent!)!;
      expect(pending.subject).toBe(ARTICLE_APPROVED_SUBJECT);
      const event = JSON.parse(pending.payload);
      const a = new SimulatedDestination("dummy-a", "draft", { uncertainTimes: 1 }),
        b = new SimulatedDestination("dummy-b", "draft");
      for (const destination of [a, b]) {
        const run = () =>
          handleApprovedArticle({
            payload: pending.payload,
            destination,
            content,
            operations,
            owner: "synthetic-continuation",
            schedule: { delayMs: 0 },
          });
        await run();
        await run();
      }
      expect(await readDummyDeliveryProof(content, event.data)).toBeDefined();
      await w.workflowSubmit(p.input);
      expect((await w.workflowAttach()).draft).toEqual(result.draft);
      expect(t.counts()).toEqual({ writerCalls: 1, assessmentCalls: 1, judgmentCalls: 1 });
    } finally {
      await t.env.stop();
    }
  });
  it.each([1, 2])("counts the seed edit within a frozen allowance of %i", async (bound) => {
    const frozen = { ...policy, maxRevisions: bound };
    const t = await start({ decisions: [REVISE], configured: frozen });
    try {
      const { result } = await t.submit(`bounded-${bound}`, frozen);
      expect(result.outcome).toBe("rejected");
      expect(t.counts().writerCalls).toBe(bound);
      const saved = JSON.parse(await content.read(result.summary));
      expect(saved.newCounts.revisions).toBe(bound);
      expect(saved.newCounts.assessments).toBe(bound);
    } finally {
      await t.env.stop();
    }
  });
  it.each(["raw", "commit"] as const)(
    "replays interruption after %s retention without another paid call",
    async (crash) => {
      const t = await start({ crash });
      try {
        expect((await t.submit(`crash-${crash}`)).result.outcome).toBe("verified");
        expect(t.counts().writerCalls).toBe(1);
      } finally {
        await t.env.stop();
      }
    },
  );
  it("keeps exact work/counts/approval when only inner history persistence fails", async () => {
    const t = await start({ decisions: [REVISE, APPROVE], crash: "inner-summary" });
    try {
      const { result } = await t.submit("summary-failure");
      expect(result.outcome).toBe("failed");
      expect(result.reason).toBe("editorial-summary-unavailable");
      const saved = JSON.parse(await content.read(result.summary));
      expect(saved.editorialSummaryUnavailable).toBe(true);
      expect(saved.newCounts).toEqual({
        revisionAttempts: 2,
        revisions: 2,
        assessments: 2,
        judgments: 2,
      });
      expect(saved.draft).toEqual(result.draft);
      expect(saved.approvalEvent).toBeDefined();
      expect(t.counts().writerCalls).toBe(2);
    } finally {
      await t.env.stop();
    }
  });
  it("attaches an existing intent after its own edit and a policy change; changed seed conflicts", async () => {
    const t = await start();
    try {
      const { p, result } = await t.submit("reconnect");
      const again = await t.prepare("reconnect", { ...policy, maxRevisions: 1 });
      expect(again.workflowKey).toBe(p.workflowKey);
      expect(again.intent.policy).toEqual(policy);
      expect(again.repeatedIntent).toBe(true);
      const external = restateEditorialContinuation(t.env.baseUrl());
      const receipt = await external.submit(again.workflowKey, again.input);
      expect(receipt.repeated).toBe(true);
      expect(((await external.attach(again.workflowKey, 30_000)) as any).draft).toEqual(
        result.draft,
      );
      await expect(
        t.prepare("reconnect", policy, {
          ...t.f.request,
          metadata: { ...t.f.request.metadata, hash: `sha256:${"f".repeat(64)}` },
        }),
      ).rejects.toMatchObject({ code: "identity-conflict" });
      expect(t.counts().writerCalls).toBe(1);
    } finally {
      await t.env.stop();
    }
  });
  it("keeps a recorded intent's policy even if config changes before first server submission", async () => {
    const t = await start({
      configured: { ...policy, maxRevisions: 1 },
      decisions: [REVISE, APPROVE],
    });
    try {
      const { result } = await t.submit("delayed-first-submit", policy);
      expect(result.outcome).toBe("verified");
      expect(t.counts().writerCalls).toBe(2);
    } finally {
      await t.env.stop();
    }
  });
  it("refuses an unfinished parent and a stale metadata-only base before a paid edit", async () => {
    const t = await start({ parentStarted: false });
    try {
      await expect(t.prepare("not-finished")).rejects.toMatchObject({
        code: "parent-not-complete",
      });
      const p = await t.prepare("direct-guard", policy, t.f.request, {
        read: async () => ({
          state: "completed",
          outcome: "rejected",
          summary: t.f.request.parent.summary,
        }),
      });
      const w = t.ingress.workflowClient(t.Continuation, p.workflowKey);
      await w.workflowSubmit(p.input);
      expect((await w.workflowAttach()).reason).toBe("parent-not-complete");
      expect(t.counts().writerCalls).toBe(0);
    } finally {
      await t.env.stop();
    }
    const other = await start();
    try {
      const p = await other.prepare("stale-first-submit");
      const old = other.f.request.metadata;
      const meta = JSON.parse(await content.read(artifactRef(old)));
      await content.revise(
        old.path,
        JSON.stringify({ ...meta, fields: { ...meta.fields, title: "A concurrent title" } }),
        old.hash.slice(7),
      );
      const w = other.ingress.workflowClient(other.Continuation, p.workflowKey);
      await w.workflowSubmit(p.input);
      expect((await w.workflowAttach()).reason).toBe("stale-base");
      expect(other.counts().writerCalls).toBe(0);
    } finally {
      await other.env.stop();
    }
  });
  it("does not propagate rejected unknown payload fields into app artifacts", async () => {
    const t = await start();
    try {
      const marker = "synthetic-sensitive-extra-field-marker";
      const w = t.ingress.workflowClient(t.Continuation, "invalid-input-key");
      await w.workflowSubmit({
        version: "editorial-continuation-run-v1",
        requestId: "bad",
        secretExtra: marker,
      } as never);
      const out = await w.workflowAttach();
      expect(out.reason).toBe("invalid-input");
      expect(JSON.stringify(out)).not.toContain(marker);
      expect(await content.read(out.summary)).not.toContain(marker);
      expect(t.counts().writerCalls).toBe(0);
    } finally {
      await t.env.stop();
    }
  });
});
