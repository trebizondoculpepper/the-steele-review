import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect, describe } from "vite-plus/test";
import { GitArtifactStore, ArtifactStoreError } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import { prepareEditorialContinuation } from "../../src/workflow/editorial-continuation-submission.js";
import { editorialStages } from "../../src/workflow/editorial-stages.js";
import { runEditorialLoop } from "../../src/workflow/editorial-loop.js";
import { DEFAULT_JUDGE_PROMPT, readJudgmentTask } from "../../src/drafting/editorial-judgment.js";
import {
  artifactRef,
  artifactReference,
  readPublicationPayload,
} from "../../src/drafting/publication-payload.js";
import { readEditorialRecoveryCheckpoint } from "../../src/drafting/editorial-recovery-checkpoint.js";
import {
  continuationParentFixture,
  REVISE,
  APPROVE,
} from "../workflow/editorial-continuation-fixtures.js";
import { parseJudgmentDocument } from "../../src/drafting/judgment-document.js";
import { WRITER } from "../publishing/approval-fixtures.js";
let dir: string, content: GitArtifactStore, operations: OperationStore;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "editorial-checkpoint-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
async function fixture(spent = 1, override = false) {
  const parent = await continuationParentFixture(content, operations);
  const policy = { version: "assess-judge-v1" as const, maxRevisions: 2, deadlineMs: 120000 };
  const prepared = await prepareEditorialContinuation({
    seed: parent.request,
    requestId: "denied-continuation",
    policy,
    content,
    archive: parent.archive,
    operations,
    parentCompletion: {
      read: async () => ({
        state: "completed",
        outcome: "rejected",
        summary: parent.request.parent.summary,
      }),
    },
  });
  const lineage = {
    intent: artifactRef(prepared.input.intent),
    parentSummary: artifactRef(parent.request.parent.summary),
  };
  const attemptId = `editorial-continuation-${hash([prepared.workflowKey, prepared.input.intent]).slice(0, 32)}`;
  const calls = { writer: 0, assessor: 0, judge: 0 };
  const stages = editorialStages({
    content,
    archive: parent.archive,
    operations,
    writer: {
      modelVersion: "synthetic/writer",
      complete: async () => {
        calls.writer++;
        const value = JSON.parse(WRITER);
        value.title = "A narrower synthetic article";
        value.responses[0].text =
          "The supplied treaty prohibits hostile environmental modification. This is a scoped account.";
        return JSON.stringify(value);
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
        calls.judge++;
        if (calls.judge < spent) return override ? APPROVE : REVISE;
        throw new ModelProviderError("unauthorised");
      },
    },
  });
  if (override) {
    const assess = stages.assess.bind(stages);
    stages.assess = async (...args) => {
      const result = await assess(...args);
      if (calls.assessor !== 1) return result;
      const record = JSON.parse(await content.read(result.ref));
      record.deterministicFindings = [
        {
          passage: "Synthetic scope fault",
          reason: "The retained source does not support this scope.",
        },
      ];
      return {
        ...result,
        ref: await content.write(
          `assessments/pub/p1/override-${hash(record)}.json`,
          JSON.stringify(record),
        ),
      };
    };
  }
  const edited = await stages.revise(
    { draft: artifactRef(parent.request.body), metadata: artifactRef(parent.request.metadata) },
    artifactRef(parent.request.package),
    artifactRef(parent.request.judgment),
    1,
    parent.summary.input.sourceUrl,
    attemptId,
    lineage,
  );
  if (!edited.version) throw new Error(`fixture edit failed: ${edited.failure}`);
  const out = await runEditorialLoop({
    stages,
    policy: { ...policy, maxRevisions: 1 },
    draft: edited.version.draft,
    package: artifactRef(parent.request.package),
    sourceUrl: parent.summary.input.sourceUrl,
    attemptId,
    recoveryId: attemptId,
    lineage,
    priorHistory: parent.request.history,
    revisionOffset: 1,
    now: async () => Date.parse("2026-01-02T00:00:00Z"),
    step: async (_name, work) => work(),
    progress: async () => {},
    save: async (history) =>
      content.write(
        `editorial-continuation-loops/${hash([prepared.input.intent, history])}.json`,
        JSON.stringify({
          ...history,
          lineage,
          parentCounts: { assessments: 1, judgments: 1, revisions: 0 },
        }),
      ),
  });
  const raw = {
    version: "editorial-continuation-history-v1",
    workflowKey: prepared.workflowKey,
    input: prepared.input,
    parent: parent.request.parent,
    parentCounts: { assessments: 1, judgments: 1, revisions: 0 },
    policy,
    intent: prepared.input.intent,
    source: {
      ...parent.pkg.post,
      sourceVersion: parent.pkg.source.sourceVersion,
      sourceUrl: parent.summary.input.sourceUrl,
    },
    outcome: "failed",
    reason: "editorial judgment provider-failed",
    initial: {
      draft: artifactRef(parent.request.body),
      metadata: artifactRef(parent.request.metadata),
    },
    seedEdit: edited.version,
    editorial: out.history,
    draft: out.draft,
    metadata: out.metadata,
    newCounts: { revisionAttempts: spent, revisions: spent, assessments: spent, judgments: spent },
    mechanicalRuns: [edited.mechanicalRun!, ...out.history.mechanicalRuns],
    retainedWriterAttempts: [
      ...(edited.retainedAttempts ?? []),
      ...(out.history.retainedWriterAttempts ?? []),
    ],
    diagnostics: [],
    completedAt: "2026-01-02T00:00:01.000Z",
  };
  const summary = await content.write(
    `editorial-continuations/${hash(raw)}.json`,
    JSON.stringify(raw),
  );
  const judgmentRef = out.history.judgments.at(-1)!,
    judgment = JSON.parse(await content.read(judgmentRef));
  const capture = judgment.retainedAttempts[0],
    manifest = JSON.parse(await content.read(artifactRef(capture)));
  const request = {
    version: "editorial-recovery-checkpoint-v1",
    parent: { workflowKey: prepared.workflowKey, summary: artifactReference(summary) },
    intent: prepared.input.intent,
    body: artifactReference(out.draft),
    metadata: artifactReference(out.metadata),
    publication: judgment.publication,
    package: parent.request.package,
    assessment: judgment.assessment,
    judgment: artifactReference(judgmentRef),
    capture,
    input: manifest.input,
  };
  const read = (overrides: Partial<Parameters<typeof readEditorialRecoveryCheckpoint>[0]> = {}) =>
    readEditorialRecoveryCheckpoint({
      request,
      content,
      archive: parent.archive,
      operations,
      currentJudge: { modelVersion: "synthetic/judge" },
      ...overrides,
    });
  return { parent, prepared, calls, request, raw, manifest, judgment, read };
}
describe("operational recovery checkpoint", { timeout: 120000 }, () => {
  it("validates the denied saved task without repeating any provider and preserves spent/remaining counts", async () => {
    const f = await fixture(),
      before = { ...f.calls },
      checkpoint = await f.read();
    expect(checkpoint.remainingEdits).toBe(1);
    expect(checkpoint.originalCounts.revisionAttempts).toBe(1);
    expect(checkpoint.originalPolicy.maxRevisions).toBe(2);
    expect(checkpoint.parentCompletionRequired).toEqual({
      workflowName: "EditorialContinuation",
      ...f.request.parent,
    });
    expect(f.calls).toEqual(before);
    const descriptor = JSON.parse(await content.read(artifactRef(f.request.input)));
    expect(checkpoint.task).toEqual(descriptor.request);
    expect(checkpoint.taskDigest).toBe(hash(descriptor));
    expect(checkpoint.lineage.intent).toEqual(artifactRef(f.prepared.input.intent));
  });
  it.each(["model", "prompt", "body-hash", "input-hash", "repository", "metadata-only"])(
    "refuses %s mismatch",
    async (kind) => {
      const f = await fixture();
      if (kind === "model")
        await expect(f.read({ currentJudge: { modelVersion: "other/model" } })).rejects.toThrow(
          "task-mismatch",
        );
      else if (kind === "prompt")
        await expect(
          f.read({
            currentJudge: {
              modelVersion: "synthetic/judge",
              prompt: {
                ...DEFAULT_JUDGE_PROMPT,
                instructions: DEFAULT_JUDGE_PROMPT.instructions + "\nChanged",
              },
            },
          }),
        ).rejects.toThrow("task-mismatch");
      else if (kind === "metadata-only") {
        const meta = JSON.parse(await content.read(artifactRef(f.request.metadata)));
        meta.fields.title = "A changed title";
        await content.revise(
          f.request.metadata.path,
          JSON.stringify(meta),
          f.request.metadata.hash.slice(7),
        );
        await expect(f.read()).rejects.toThrow("stale-base");
      } else {
        const request = structuredClone(f.request);
        if (kind === "body-hash") request.body.hash = `sha256:${"0".repeat(64)}`;
        if (kind === "input-hash") request.input.hash = `sha256:${"0".repeat(64)}`;
        if (kind === "repository") request.capture.repository = "other";
        await expect(f.read({ request })).rejects.toThrow();
      }
    },
  );
  it("propagates operational errors in the shared judge-task nested reads", async () => {
    const f = await fixture(),
      assessment = JSON.parse(await content.read(artifactRef(f.request.assessment)));
    let findingsReads = 0;
    const failing = new Proxy(content, {
      get(target, key) {
        if (key === "read")
          return async (ref: Parameters<GitArtifactStore["read"]>[0]) => {
            if (ref.path === assessment.document.path && ++findingsReads === 2)
              throw new ArtifactStoreError("git-failed");
            return target.read(ref);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(f.read({ content: failing })).rejects.toMatchObject({ code: "git-failed" });
    expect(f.calls).toEqual({ writer: 1, assessor: 1, judge: 1 });
  });
  it("preserves the existing judge serialization exactly", async () => {
    const f = await fixture(),
      descriptor = JSON.parse(await content.read(artifactRef(f.request.input))),
      assessment = JSON.parse(await content.read(artifactRef(f.request.assessment)));
    const task = await readJudgmentTask({ content, assessment, history: f.judgment.history });
    expect(task.request).toEqual(descriptor.request);
    expect(JSON.stringify(task.request)).toBe(JSON.stringify(descriptor.request));
    const user = JSON.parse(task.request!.user);
    expect(Object.keys(user)).toEqual([
      "article",
      "publication",
      "findings",
      "deterministicFindings",
      "priorJudgmentGuidance",
    ]);
    expect(task.request!.system).toBe(DEFAULT_JUDGE_PROMPT.instructions);
    expect(task.request!.maxOutputChars).toBe(40000);
    const { payload } = await readPublicationPayload(content, assessment.publication);
    const priorJudgmentGuidance = [];
    for (const item of f.judgment.history) {
      const prior = JSON.parse(await content.read(artifactRef(item.judgment)));
      const guidance = parseJudgmentDocument(await content.read(artifactRef(prior.document)))!;
      priorJudgmentGuidance.push({
        ...item,
        effectiveDecision: prior.decision,
        deterministicGates: prior.gates,
        requiredCorrections: guidance.requiredCorrections,
        acceptedMinorObservations: guidance.acceptedMinorObservations,
      });
    }
    const legacyUser = JSON.stringify({
      article: await content.read(artifactRef(assessment.body)),
      publication:
        payload.mode === "structured"
          ? { mode: "structured", ...payload.fields }
          : { mode: "legacy-body-only" },
      findings: await content.read(artifactRef(assessment.document)),
      deterministicFindings: assessment.deterministicFindings,
      ...(priorJudgmentGuidance.length ? { priorJudgmentGuidance } : {}),
    });
    expect(task.request!.user).toBe(legacyUser);
    expect(createHash("sha256").update(task.request!.user).digest("hex")).toBe(
      createHash("sha256").update(legacyUser).digest("hex"),
    );
  });
  it("keeps an exhausted edit allowance at zero rather than granting new edits", async () => {
    const f = await fixture(2);
    expect({
      calls: f.calls,
      revisions: f.raw.editorial.revisions.length,
      attempts: f.raw.editorial.revisionAttempts,
      terminal: f.raw.editorial.terminal,
    }).toEqual({
      calls: { writer: 2, assessor: 2, judge: 2 },
      revisions: 1,
      attempts: 1,
      terminal: "operational-stop",
    });
    const checkpoint = await f.read();
    expect(checkpoint.remainingEdits).toBe(0);
    expect(checkpoint.originalCounts.revisionAttempts).toBe(2);
  });
  it("refuses returned, ambiguous or late captures and incomplete assessment documents", async () => {
    const f = await fixture();
    const patched = (path: string, edit: (value: any) => any) =>
      new Proxy(content, {
        get(target, key) {
          if (key === "read")
            return async (ref: Parameters<GitArtifactStore["read"]>[0]) => {
              const raw = await target.read(ref);
              return ref.path === path ? JSON.stringify(edit(JSON.parse(raw))) : raw;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    for (const edit of [
      (v: any) => ({ ...v, outcome: "returned", failure: undefined, raw: f.request.body }),
      (v: any) => ({ ...v, failure: "unavailable" }),
      (v: any) => ({ ...v, lateResponse: true }),
      (v: any) => ({ ...v, kind: "revision" }),
      (v: any) => ({ ...v, number: 2 }),
      (v: any) => ({ ...v, revision: 1 }),
      (v: any) => ({ ...v, repairPromptVersion: "synthetic-repair" }),
      (v: any) => ({ ...v, completion: { stopReason: "completed" } }),
      (v: any) => ({ ...v, completion: { stopReason: "length-limit" } }),
      (v: any) => ({
        ...v,
        completion: { stopReason: "unknown", resolvedModel: "synthetic/judge" },
      }),
    ])
      await expect(f.read({ content: patched(f.request.capture.path, edit) })).rejects.toThrow(
        "not-denied",
      );
    await expect(
      f.read({
        content: patched(f.request.assessment.path, (v) => ({ ...v, state: "incomplete" })),
      }),
    ).rejects.toThrow("chain-mismatch");
    await expect(
      f.read({
        content: patched(f.request.input.path, (v) => ({
          ...v,
          request: { ...v.request, user: v.request.user + " " },
        })),
      }),
    ).rejects.toThrow("task-mismatch");
    const late = new Proxy(content, {
      get(target, key) {
        if (key === "lookup")
          return async (path: string) =>
            path.endsWith("/late-response.json")
              ? artifactRef(f.request.capture)
              : target.lookup(path);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(f.read({ content: late })).rejects.toThrow("not-denied");
    const activeCapture = new Proxy(operations, {
      get(target, key) {
        if (key === "operationStatus")
          return (k: string) =>
            k.startsWith("editorial-capture:")
              ? { key: k, status: "claimed", attempts: 1, exhausted: false }
              : target.operationStatus(k);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(f.read({ operations: activeCapture })).rejects.toThrow("not-denied");

    expect(f.calls).toEqual({ writer: 1, assessor: 1, judge: 1 });
  });
  it("refuses missing counters and any existing approval or pending handoff", async () => {
    const f = await fixture();
    const missing = new Proxy(content, {
      get(target, key) {
        if (key === "read")
          return async (ref: Parameters<GitArtifactStore["read"]>[0]) => {
            const raw = await target.read(ref);
            if (ref.path !== f.request.parent.summary.path) return raw;
            const value = JSON.parse(raw);
            delete value.newCounts;
            return JSON.stringify(value);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(f.read({ content: missing })).rejects.toThrow("chain-mismatch");
    for (const which of ["state", "event"]) {
      const state = new Proxy(operations, {
        get(target, key) {
          if (key === "operationStatus")
            return (k: string) =>
              which === "state" && k.startsWith("approved:")
                ? { key: k, status: "claimed", attempts: 1, exhausted: false }
                : target.operationStatus(k);
          if (key === "pendingEvent")
            return (k: string) => (which === "event" ? { eventId: k } : target.pendingEvent(k));
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await expect(f.read({ operations: state })).rejects.toThrow("approval-present-or-uncertain");
    }
  });
  it("refuses a changed source and an actual current-body edit", async () => {
    const f = await fixture();
    const archive = {
      ...f.parent.archive,
      read: async (ref: Parameters<GitArtifactStore["read"]>[0]) => {
        const value = JSON.parse(await f.parent.archive.read(ref));
        value.item.url = "https://other.example.invalid/p/other";
        return JSON.stringify(value);
      },
    };
    await expect(f.read({ archive })).rejects.toThrow("chain-mismatch");
    await content.revise(
      f.request.body.path,
      "Changed canonical body",
      f.request.body.hash.slice(7),
    );
    await expect(f.read()).rejects.toThrow("stale-base");
  });
  it("accepts a deterministic effective REVISE override, but refuses an ungated or unrelated-gate APPROVE", async () => {
    const f = await fixture(2, true);
    const firstRef = f.raw.editorial.judgments[0];
    const first = JSON.parse(await content.read(firstRef));
    expect(first.decision).toBe("revise");
    expect(first.gates).toContain("deterministic-fault-blocks-approval");
    expect(parseJudgmentDocument(await content.read(artifactRef(first.document)))?.decision).toBe(
      "approve",
    );
    expect((await f.read()).remainingEdits).toBe(0);
    for (const gates of [[], ["unrelated-gate"]]) {
      const patched = new Proxy(content, {
        get(target, key) {
          if (key === "read")
            return async (ref: Parameters<GitArtifactStore["read"]>[0]) => {
              const raw = await target.read(ref);
              return ref.path === firstRef.path
                ? JSON.stringify({ ...JSON.parse(raw), gates })
                : raw;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await expect(f.read({ content: patched })).rejects.toThrow("chain-mismatch");
    }
    expect(f.calls).toEqual({ writer: 2, assessor: 2, judge: 2 });
  });
});
