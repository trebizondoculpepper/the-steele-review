import { commitArticleRevision } from "../../src/drafting/article-revisions.js";
import type { JudgmentHistory } from "../../src/content/judgment-history.js";
import { editorialAttemptIdentity } from "../../src/workflow/editorial-attempt-identity.js";
import { OperationStoreError } from "../../src/controllers/operation-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ArtifactStoreError, GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { ModelProviderError } from "../../src/controllers/openrouter.js";
import { editorialStages } from "../../src/workflow/editorial-stages.js";
import {
  artifactRef,
  artifactReference,
  readPublicationPayload,
  savePublicationPayload,
} from "../../src/drafting/publication-payload.js";
import { PackageVerificationReportSchema } from "../../src/drafting/package-verify.js";
import { JudgmentRecordSchema } from "../../src/drafting/editorial-judgment.js";
import { ARTICLE_APPROVED_SUBJECT } from "../../src/events/article-approved-event.js";
import {
  handleApprovedArticle,
  readDummyDeliveryProof,
  SimulatedDestination,
} from "../../src/publishing/approved-article.js";
import { approvedReport, archive, WRITER } from "../publishing/approval-fixtures.js";
let dir: string, content: GitArtifactStore, operations: OperationStore;
const APPROVE =
  "## Reasons\nThe material facts and sources are supported.\n## Required corrections\nNone.\n## Accepted minor observations\nNone.\nDECISION: APPROVE";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "editorial-stages-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
async function seeded(
  options: {
    assessor?: () => Promise<string>;
    writer?: (request: any) => Promise<string>;
    judge?: (request: { system: string; user: string }) => Promise<string>;
    legacy?: boolean;
  } = {},
) {
  const report = PackageVerificationReportSchema.parse(
    JSON.parse(
      await content.read(await approvedReport(content, "approved", options.legacy ?? false)),
    ),
  );
  if (report.schemaVersion !== 2) throw new Error("legacy");
  const stages = editorialStages({
    content,
    operations,
    archive,
    assessor: {
      modelVersion: "fake/assessor",
      complete: options.assessor ?? (async () => "No faults found.\nEND OF ASSESSMENT"),
    },
    judge: { modelVersion: "fake/judge", complete: options.judge ?? (async () => APPROVE) },
    writer: {
      modelVersion: "fake/editorial-writer",
      complete: options.writer ?? (async () => WRITER),
    },
  });
  let draft = artifactRef(report.draft);
  if (options.legacy) {
    const { payload } = await readPublicationPayload(content, report.publication);
    const committed = await commitArticleRevision({
      content,
      article: { publicationId: "pub", postId: "p1" },
      generation: { draft, metadata: artifactRef(payload.metadata) },
      base: "current",
    });
    if (committed.status === "conflict") throw new Error("fixture legacy conflict");
    draft = committed.body;
  }
  const version = await stages.prepare(draft, artifactRef(report.package));
  return { stages, version, pkg: artifactRef(report.package) };
}
describe("typed editorial stages and judgment-backed delivery", { timeout: 60000 }, () => {
  it("releases a completed cycle with the judge's real decision, never as an approval (#820)", async () => {
    const REVISE =
      "## Reasons\nOne claim is overstated.\n## Required corrections\n- Qualify the claim.\n## Accepted minor observations\nNone.\nDECISION: REVISE";
    const { stages, version, pkg } = await seeded({ judge: async () => REVISE });
    const assessed = await stages.assess(version, pkg, "cycle:assessment:1");
    const judged = await stages.judge(assessed.ref, "cycle:judgment:1");
    expect(judged.decision).toBe("revise");
    // A "revise" judgment is never an editorial approval...
    await expect(stages.approve(judged.ref)).rejects.toThrow();
    // ...but a completed cycle may be released, recording the actual decision.
    const released = await stages.approveCompletedCycle!(judged.ref);
    const pending = operations
      .duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)
      .find((x) => x.eventId === released.eventId)!;
    const event = JSON.parse(pending.payload);
    expect(event.data).toMatchObject({
      approvalKind: "editorial-cycle-complete",
      judgmentDecision: "revise",
      approval: artifactReference(judged.ref),
      assessment: artifactReference(assessed.ref),
      draft: artifactReference(version.draft),
    });
    // Recording it twice is one event (stable operation identity).
    expect((await stages.approveCompletedCycle!(judged.ref)).eventId).toBe(released.eventId);
    // Delivered once to a destination, with the decision kept on the receipt.
    const dest = new SimulatedDestination("dummy-cycle", "draft");
    const handle = () =>
      handleApprovedArticle({
        payload: pending.payload,
        destination: dest,
        schedule: { delayMs: 0 },
        content,
        operations,
        owner: "fixture",
        now: () => new Date(Date.parse(event.time) + 1000),
        retryDelayMs: 1,
      });
    expect(await handle()).toMatchObject({ action: "ack", outcome: "delivered" });
    expect(await handle()).toMatchObject({ action: "ack", outcome: "reused" });
  });

  it("hands the judge feasible citation-correction capabilities without relaxing approval", async () => {
    const f = await seeded({
      judge: async (request) => {
        expect(request.system).toContain(
          "global display numbers, not writer-local evidence indices",
        );
        expect(request.system).toContain("it cannot borrow another claim's index");
        expect(request.system).toContain("or approve an unsupported factual sentence");
        return APPROVE;
      },
    });
    const assessment = await f.stages.assess(f.version, f.pkg, "citation-capability-assess");
    const judgment = await f.stages.judge(assessment.ref, "citation-capability-judge");
    expect(judgment.decision).toBe("approve");
  });

  it("approves actual assessment/judgment refs, delivers exact fields twice independently and reconciles uncertainty", async () => {
    const { stages, version, pkg } = await seeded();
    const assessed = await stages.assess(version, pkg, "fixture:assessment:0");
    const judged = await stages.judge(assessed.ref, "fixture:judgment:0");
    expect(judged.decision).toBe("approve");
    const approval = await stages.approve(judged.ref);
    const pending = operations
      .duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)
      .find((x) => x.eventId === approval.eventId)!;
    const event = JSON.parse(pending.payload);
    expect(event.data).toMatchObject({
      approvalKind: "editorial-judgment",
      approval: artifactReference(judged.ref),
      assessment: artifactReference(assessed.ref),
      draft: artifactReference(version.draft),
    });
    const a = new SimulatedDestination("dummy-a", "draft", { uncertainTimes: 1 }),
      b = new SimulatedDestination("dummy-b", "draft");
    const handle = (destination: SimulatedDestination, payload = pending.payload) =>
      handleApprovedArticle({
        payload,
        destination,
        schedule: { delayMs: 0 },
        content,
        operations,
        owner: "fixture",
        now: () => new Date(Date.parse(event.time) + 1000),
        retryDelayMs: 1,
      });
    expect(await handle(a)).toMatchObject({ action: "nak", reason: "uncertain" });
    expect(await handle(a)).toMatchObject({ action: "ack", outcome: "delivered" });
    expect(await handle(b)).toMatchObject({ action: "ack", outcome: "delivered" });
    expect(await readDummyDeliveryProof(content, event.data)).toBeDefined();
    const crossPost = {
      ...event,
      subject: "article/pub/other",
      data: { ...event.data, postId: "other" },
    };
    expect(await handle(a, JSON.stringify(crossPost))).toMatchObject({
      action: "term",
      reason: "approval-mismatch",
    });
    expect(await handle(a)).toMatchObject({ action: "ack", outcome: "reused" });
    expect(a.deliveries).toHaveLength(1);
    const metadata = JSON.parse(await content.read(version.metadata));
    const changed = await content.revise(
      version.metadata.path,
      JSON.stringify({
        ...metadata,
        fields: { ...metadata.fields, title: "A different unapproved title" },
      }),
      version.metadata.sha256,
    );
    const body = { ...version.draft, commit: changed.commit };
    const publication = await savePublicationPayload({
      content,
      metadata: changed,
      body,
      post: { publicationId: "pub", postId: "p1" },
    });
    const newEvent = {
      ...event,
      data: {
        ...event.data,
        draft: artifactReference(body),
        publication: artifactReference(publication.ref),
      },
    };
    expect(await handle(a, JSON.stringify(newEvent))).toMatchObject({
      action: "term",
      reason: "approval-mismatch",
    });
    expect(a.deliveries).toHaveLength(1);
    expect(await readPublicationPayload(content, event.data.publication)).toMatchObject({
      payload: { metadata: artifactReference(version.metadata) },
    });
  });
  it("feeds deterministic fault details to the writer even when the judge document itself said APPROVE", async () => {
    const writer = vi.fn(async (request: { user: string }) => {
      const user = JSON.parse(request.user);
      expect(user.revision.feedback).toContainEqual({
        passage: "Synthetic faulty citation",
        reason: "The citation number is not defined.",
      });
      expect(JSON.stringify(user.revision.feedback)).not.toContain("DECISION: APPROVE");
      expect(user.revision.previousFields).toHaveProperty("title");
      return WRITER;
    });
    const { stages, version, pkg } = await seeded({ writer });
    const assessed = await stages.assess(version, pkg, "fixture:assessment:0");
    const record = JSON.parse(await content.read(assessed.ref));
    const failed = await content.write(
      "fixtures/deterministic-assessment.json",
      JSON.stringify({
        ...record,
        deterministicFindings: [
          { passage: "Synthetic faulty citation", reason: "The citation number is not defined." },
        ],
      }),
    );
    const judgment = await stages.judge(failed, "fixture:judgment:0");
    expect(judgment.decision).toBe("revise");
    const revised = await stages.revise(
      version,
      pkg,
      judgment.ref,
      1,
      "https://pub.example.com/p/p1",
    );
    expect(revised.version).toBeDefined();
    expect(writer).toHaveBeenCalledTimes(1);
  });
  it("recovers a credit-stopped revision after the original mechanical deadline without reusing that budget", async () => {
    let blocked = true;
    const writer = vi.fn(async () => {
      if (blocked) throw new ModelProviderError("credit-exhausted", 402);
      return WRITER;
    });
    const f = await seeded({
      writer,
      judge: async () =>
        "## Reasons\nA material factual correction is needed.\n## Required corrections\nCorrect the material claim.\n## Accepted minor observations\nNone.\nDECISION: REVISE",
    });
    const assessment = await f.stages.assess(f.version, f.pkg, "revision-credit-assessment");
    const judgment = await f.stages.judge(assessment.ref, "revision-credit-judgment");
    const revise = (recoveryId?: string) =>
      f.stages.revise(
        f.version,
        f.pkg,
        judgment.ref,
        1,
        "https://pub.example.com/p/p1",
        recoveryId,
      );
    const identityInput = {
      publicationId: "pub",
      postId: "p1",
      sourceVersion: `sha256:${"a".repeat(64)}`,
      sourceUrl: "https://pub.example.com/p/p1",
      researchDeadlineMs: 1000,
      operatorRequestId: "operator-original",
    };
    const original = editorialAttemptIdentity(identityInput);
    const recovery = editorialAttemptIdentity({ ...identityInput, recoveryGeneration: 1 });
    expect(recovery.recoveryId).not.toBe(original.recoveryId);
    await expect(revise(original.recoveryId)).rejects.toThrow();
    expect(writer).toHaveBeenCalledTimes(1);
    blocked = false;
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 360_000);
    try {
      expect(await revise(original.recoveryId)).toMatchObject({
        failure: "mechanical-deadline-exhausted",
      });
      expect(writer).toHaveBeenCalledTimes(1);
      const recovered = await revise(recovery.recoveryId);
      expect(recovered.version).toBeDefined();
      expect(writer).toHaveBeenCalledTimes(2);
      expect((await revise(recovery.recoveryId)).version).toEqual(recovered.version);
      expect(writer).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it.each(["changed-advice", "corrected", "new-material-fault"])(
    "pins prior guidance and current faults independently: %s",
    async (mode) => {
      const correction =
        "Replace the subtitle with: The public consultation itself is a harmful plan.";
      const priorDoc = `## Reasons\nMATERIAL-REASONS-SENTINEL\n## Required corrections\n${correction}\n## Accepted minor observations\nOptional: shorten the link label.\nDECISION: REVISE`;
      let judged = 0;
      const judge = vi.fn(async (request: any) => {
        const user = JSON.parse(request.user);
        judged++;
        if (judged === 1) {
          expect(user.priorJudgmentGuidance).toBeUndefined();
          return priorDoc;
        }
        expect(user.priorJudgmentGuidance).toHaveLength(1);
        expect(user.priorJudgmentGuidance[0].requiredCorrections).toBe(correction);
        expect(user.priorJudgmentGuidance[0].effectiveDecision).toBe("revise");
        expect(user.findings).toContain(
          mode === "new-material-fault"
            ? "A genuinely new material fault"
            : "Current independent findings",
        );
        if (mode === "corrected") return APPROVE;
        return `## Reasons\n${mode === "changed-advice" ? "The writer followed my earlier replacement. That advice was wrong; the allegation concerned equipment, not the consultation. I retract it." : "A new material factual fault remains; prior guidance is no exemption."}\n## Required corrections\nCorrect the factual scope using the current evidence.\n## Accepted minor observations\nNone.\nDECISION: REVISE`;
      });
      let assessed = 0;
      const writer = vi.fn(async (request: any) => {
        const u = JSON.parse(request.user);
        expect(u.revision.feedback).toContainEqual({
          passage: "Required editorial corrections",
          reason: correction,
        });
        expect(JSON.stringify(u.revision.feedback)).not.toContain("MATERIAL-REASONS-SENTINEL");
        expect(JSON.stringify(u.revision.feedback)).not.toContain("Optional: shorten");
        expect(u.revision.nonBlockingObservations).toEqual([
          { passage: "Accepted minor observations", reason: "Optional: shorten the link label." },
        ]);
        return JSON.stringify({
          ...JSON.parse(WRITER),
          subtitle:
            mode === "corrected"
              ? "What the treaty actually establishes"
              : "The public consultation itself is a harmful plan.",
        });
      });
      const f = await seeded({
        writer,
        judge,
        assessor: async () =>
          `## Finding 1\n- Where: subtitle\n- What is wrong: ${++assessed > 1 && mode === "new-material-fault" ? "A genuinely new material fault" : "Current independent findings"}\n- Why: The current source establishes a narrower scope.\nEND OF ASSESSMENT`,
      });
      const a = await f.stages.assess(f.version, f.pkg, "history-assessment-0"),
        j = await f.stages.judge(a.ref, "history-judge-0");
      const revised = await f.stages.revise(
        f.version,
        f.pkg,
        j.ref,
        1,
        "https://pub.example.com/p/p1",
      );
      if (!revised.version) throw new Error("revision failed");
      const history: JudgmentHistory = [
        {
          judgment: artifactReference(j.ref),
          assessment: artifactReference(a.ref),
          body: artifactReference(f.version.draft),
          metadata: artifactReference(f.version.metadata),
        },
      ];
      const current = await f.stages.assess(revised.version, f.pkg, "history-assessment-1");
      const beforeRecords = await content.list("judgments/pub/p1", 100);
      const read = content.read.bind(content);
      let fail = true;
      const interrupted = vi.spyOn(content, "read").mockImplementation(async (reference) => {
        if (fail && reference.path === j.ref.path) {
          fail = false;
          throw new ArtifactStoreError("git-failed");
        }
        return read(reference);
      });
      await expect(
        f.stages.judge(current.ref, "history-judge-1", undefined, history),
      ).rejects.toMatchObject({ code: "git-failed" });
      expect(await content.list("judgments/pub/p1", 100)).toEqual(beforeRecords);
      expect(judge).toHaveBeenCalledTimes(1);
      interrupted.mockRestore();
      const next = await f.stages.judge(current.ref, "history-judge-1", undefined, history);
      expect(next.decision).toBe(mode === "corrected" ? "approve" : "revise");
      const record = JSON.parse(await content.read(next.ref));
      expect(record.history).toEqual(history);
      expect(await f.stages.judge(current.ref, "history-judge-1", undefined, history)).toEqual(
        next,
      );
      expect(judge).toHaveBeenCalledTimes(2);
      expect(writer).toHaveBeenCalledTimes(1);
      const invalid = structuredClone(history);
      invalid[0]!.metadata = artifactReference(f.pkg);
      expect(
        await f.stages.judge(current.ref, "history-mismatch", undefined, invalid),
      ).toMatchObject({ state: "gated", decision: "none" });
      const unreadable = structuredClone(history);
      unreadable[0]!.judgment.commit = "0".repeat(40);
      expect(
        await f.stages.judge(current.ref, "history-unreadable", undefined, unreadable),
      ).toMatchObject({ state: "gated", decision: "none" });
      expect(judge).toHaveBeenCalledTimes(2);
    },
  );
  it("accepts exact legacy body-only history after a structured revision", async () => {
    let calls = 0;
    const judge = vi.fn(async (request: any) => {
      const u = JSON.parse(request.user);
      if (++calls === 1) {
        expect(u.publication.mode).toBe("legacy-body-only");
        return "## Reasons\nA material correction.\n## Required corrections\nCorrect the summary.\n## Accepted minor observations\nNone.\nDECISION: REVISE";
      }
      expect(u.publication.mode).toBe("structured");
      expect(u.priorJudgmentGuidance).toHaveLength(1);
      return APPROVE;
    });
    const f = await seeded({ judge, legacy: true });
    const a = await f.stages.assess(f.version, f.pkg, "legacy-history-assessment-0"),
      j = await f.stages.judge(a.ref, "legacy-history-judge-0");
    const first = JSON.parse(await content.read(j.ref));
    expect((await readPublicationPayload(content, first.publication)).payload.mode).toBe(
      "legacy-body-only",
    );
    const revised = await f.stages.revise(
      f.version,
      f.pkg,
      j.ref,
      1,
      "https://pub.example.com/p/p1",
    );
    if (!revised.version) throw new Error("revision failed");
    expect(JSON.parse(await content.read(revised.version.metadata))).toHaveProperty("fields");
    const current = await f.stages.assess(revised.version, f.pkg, "legacy-history-assessment-1");
    const history = [
      {
        judgment: artifactReference(j.ref),
        assessment: artifactReference(a.ref),
        body: artifactReference(f.version.draft),
        metadata: artifactReference(f.version.metadata),
      },
    ];
    expect(
      await f.stages.judge(current.ref, "legacy-history-judge-1", undefined, history),
    ).toMatchObject({ decision: "approve", state: "decided" });
    expect(judge).toHaveBeenCalledTimes(2);
  });
  it("preserves absent-history reuse and captures a valid five-round history without overflowing context bounds", async () => {
    const reviseDoc =
      "## Reasons\nA material correction is requested.\n## Required corrections\nCorrect the summary.\n## Accepted minor observations\nNone.\nDECISION: REVISE";
    const judge = vi.fn(async () => reviseDoc),
      f = await seeded({ judge });
    const a = await f.stages.assess(f.version, f.pkg, "max-history-assessment"),
      prior = [];
    const first = await f.stages.judge(a.ref, "max-history-0");
    expect(await f.stages.judge(a.ref, "max-history-0", undefined, [])).toEqual(first);
    expect(JSON.parse(await content.read(first.ref))).not.toHaveProperty("history");
    for (let i = 0; i < 5; i++) {
      const j = i === 0 ? first : await f.stages.judge(a.ref, `max-history-${i}`);
      prior.push({
        judgment: artifactReference(j.ref),
        assessment: artifactReference(a.ref),
        body: artifactReference(f.version.draft),
        metadata: artifactReference(f.version.metadata),
      });
    }
    const final = await f.stages.judge(a.ref, "max-history-final", undefined, prior);
    expect(final.state).toBe("decided");
    const record = JSON.parse(await content.read(final.ref));
    expect(record.history).toHaveLength(5);
    const changed = await f.stages.judge(a.ref, "max-history-final", undefined, prior.slice(0, 4));
    expect(changed.ref).not.toEqual(final.ref);
    expect(JSON.parse(await content.read(changed.ref)).history).toHaveLength(4);
    expect(await f.stages.judge(a.ref, "max-history-final", undefined, prior)).toEqual(final);
    for (const ref of record.retainedAttempts) {
      const manifest = JSON.parse(await content.read(artifactRef(ref)));
      expect(manifest.context).toHaveLength(7);
    }
  });
  it.each(["assessor", "judge"])(
    "keeps a failed %s attempt and credit category without fictional approval",
    async (role) => {
      const { stages, version, pkg } = await seeded({
        assessor:
          role === "assessor"
            ? async () => {
                throw new ModelProviderError("credit-exhausted", 402);
              }
            : undefined,
      });
      if (role === "assessor") {
        const out = await stages.assess(version, pkg, "credit:assessment:0");
        const record = JSON.parse(await content.read(out.ref));
        expect(out).toMatchObject({
          state: "provider-failed",
          operationalFailure: "credit-exhausted",
        });
        expect(record.retainedAttempts).toHaveLength(1);
        expect(record.attemptId).toBe("credit:assessment:0");
      } else {
        const assessed = await stages.assess(version, pkg, "credit:assessment:0");
        // Use the real stage factory with a failing judge, preserving this exact saved assessment.
        const failing = editorialStages({
          content,
          operations,
          archive,
          writer: { modelVersion: "fake/writer", complete: async () => WRITER },
          judge: {
            modelVersion: "fake/credit-judge",
            complete: async () => {
              throw new ModelProviderError("credit-exhausted", 402);
            },
          },
        });
        const out = await failing.judge(assessed.ref, "credit:judgment:0");
        const record = JudgmentRecordSchema.parse(JSON.parse(await content.read(out.ref)));
        expect(out).toMatchObject({
          state: "provider-failed",
          operationalFailure: "credit-exhausted",
          decision: "none",
        });
        expect(record.retainedAttempts).toHaveLength(1);
        expect(record.attemptId).toBe("credit:judgment:0");
        await expect(failing.approve(out.ref)).rejects.toThrow();
      }
      expect(operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)).toHaveLength(0);
    },
  );
  it.each(["assessor", "judge"])(
    "recovers dashboard-shaped credit stop at %s using new role path and capture token",
    async (role) => {
      let blocked = true;
      const call = vi.fn(async () => {
        if (blocked) throw new ModelProviderError("credit-exhausted", 402);
        return role === "assessor" ? "No faults found.\nEND OF ASSESSMENT" : APPROVE;
      });
      const f = await seeded(role === "assessor" ? { assessor: call } : { judge: call });
      const input = {
        publicationId: "pub",
        postId: "p1",
        sourceVersion: `sha256:${"a".repeat(64)}`,
        sourceUrl: "https://pub.example.com/p/p1",
        researchDeadlineMs: 1000,
      };
      const original = editorialAttemptIdentity(input),
        recovery = editorialAttemptIdentity({ ...input, recoveryGeneration: 1 });
      expect(recovery.attemptId).not.toBe(original.attemptId);
      expect(recovery.recoveryId).toMatch(/^dashboard-recovery-/);
      const assessment =
        role === "judge" ? await f.stages.assess(f.version, f.pkg, "saved-assessment") : undefined;
      const invoke = (identity: typeof original) =>
        role === "assessor"
          ? f.stages.assess(f.version, f.pkg, identity.attemptId, identity.recoveryId)
          : f.stages.judge(assessment!.ref, identity.attemptId, identity.recoveryId);
      const failed = await invoke(original);
      expect(failed.operationalFailure).toBe("credit-exhausted");
      blocked = false;
      const returned = await invoke(recovery);
      expect(returned.state).toBe(role === "assessor" ? "no-faults" : "decided");
      expect(returned.ref.path).not.toBe(failed.ref.path);
      const stored = JSON.parse(await content.read(returned.ref));
      expect(stored.retainedAttempts).toHaveLength(1);
      expect(stored.attemptId).toBe(recovery.attemptId);
      expect((await invoke(recovery)).ref).toEqual(returned.ref);
      expect(call).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["assessor", "judge"])(
    "retries actual retained-response manifest failure through %s without another paid call",
    async (role) => {
      const call = vi.fn(async () =>
        role === "assessor" ? "No faults found.\nEND OF ASSESSMENT" : APPROVE,
      );
      const f = await seeded(role === "assessor" ? { assessor: call } : { judge: call });
      const assessment =
        role === "judge" ? await f.stages.assess(f.version, f.pkg, "saved-assessment") : undefined;
      const originalWrite = content.write.bind(content);
      let blocked = false;
      vi.spyOn(content, "write").mockImplementation(async (...args) => {
        if (
          !blocked &&
          args[0].startsWith("editorial-attempts/") &&
          args[0].endsWith("/manifest.json")
        ) {
          blocked = true;
          throw new Error("synthetic capture storage failure");
        }
        return originalWrite(...args);
      });
      const invoke = () =>
        role === "assessor"
          ? f.stages.assess(f.version, f.pkg, "storage-retry")
          : f.stages.judge(assessment!.ref, "storage-retry");
      await expect(invoke()).rejects.toMatchObject({ code: "archive-failed" });
      const returned = await invoke();
      expect(returned.state).toBe(role === "assessor" ? "no-faults" : "decided");
      expect(call).toHaveBeenCalledTimes(1);
      const stored = JSON.parse(await content.read(returned.ref));
      expect(stored.retainedAttemptReuses).toEqual([true]);
    },
  );

  it.each(["fence", "state-completion"])(
    "replays actual post-response %s failure through assessor with no recall",
    async (point) => {
      const call = vi.fn(async () => "No faults found.\nEND OF ASSESSMENT");
      const f = await seeded({ assessor: call });
      let blocked = false;
      if (point === "fence") {
        const original = content.write.bind(content);
        vi.spyOn(content, "write").mockImplementation(async (...args) => {
          if (!blocked && args[0].endsWith("/fence.json")) {
            blocked = true;
            throw new Error("synthetic fence storage failure");
          }
          return original(...args);
        });
      } else {
        const original = operations.completeEditorialCapture.bind(operations);
        vi.spyOn(operations, "completeEditorialCapture").mockImplementation((...args) => {
          if (!blocked) {
            blocked = true;
            throw new OperationStoreError("busy");
          }
          return original(...args);
        });
      }
      const invoke = () => f.stages.assess(f.version, f.pkg, "post-response-retry");
      await expect(invoke()).rejects.toMatchObject({ code: "archive-failed" });
      expect((await invoke()).state).toBe("no-faults");
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
});
