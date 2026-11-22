import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
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
  options: { assessor?: () => Promise<string>; writer?: (request: any) => Promise<string> } = {},
) {
  const report = PackageVerificationReportSchema.parse(
    JSON.parse(await content.read(await approvedReport(content))),
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
    judge: { modelVersion: "fake/judge", complete: async () => APPROVE },
    writer: {
      modelVersion: "fake/editorial-writer",
      complete: options.writer ?? (async () => WRITER),
    },
  });
  const version = await stages.prepare(artifactRef(report.draft), artifactRef(report.package));
  return { stages, version, pkg: artifactRef(report.package) };
}
describe("typed editorial stages and judgment-backed delivery", { timeout: 60000 }, () => {
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
      const guidance = JSON.parse(user.revision.feedback[0].reason);
      expect(guidance).toMatchObject({
        decision: "revise",
        deterministicFindings: [
          { passage: "Synthetic faulty citation", reason: "The citation number is not defined." },
        ],
      });
      expect(guidance.judgment).toContain("DECISION: APPROVE");
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
});
