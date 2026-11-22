import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it } from "vite-plus/test";
import { GitArtifactStore, ArtifactStoreError } from "../src/controllers/artifact-store.js";
import { OperationStore } from "../src/controllers/operation-store.js";
import {
  continuationParentFixture,
  REVISE,
} from "../test/workflow/editorial-continuation-fixtures.js";
import { editorialStages } from "../src/workflow/editorial-stages.js";
import { runEditorialLoop } from "../src/workflow/editorial-loop.js";
import { WRITER } from "../test/publishing/approval-fixtures.js";
import { writeOnce } from "../src/research/job.js";
import {
  liveEditorialInput,
  recordArticleAttempt,
  articleAttemptHash,
} from "../src/workflow/article-attempt.js";
import { artifactReference } from "../src/drafting/publication-payload.js";
import { authorizeConfiguredDraft } from "../src/publishing/configured-draft-authorization.js";
import { readApprovalEvidence } from "../src/publishing/approval-evidence.js";
import { handleApprovedArticle, SimulatedDestination } from "../src/publishing/approved-article.js";
import { localDraftDestination } from "../test/publishing/draft-destination-fixture.js";
let dir: string, content: GitArtifactStore, operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "configured-draft-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});
it(
  "normal policy proof issues honest draft-only authority and shared consumers preserve exact targets",
  { timeout: 240000 },
  async () => {
    const parent = await continuationParentFixture(content, operations, 0, { modern: true });
    const normal = recordArticleAttempt(
      operations,
      liveEditorialInput(parent.summary.input),
      "normal-policy-fixture",
    );
    const pkg = JSON.parse(await content.read(parent.pkgRef));
    const stages = editorialStages({
      content,
      operations,
      archive: parent.archive,
      writer: { modelVersion: "synthetic/normal-writer", complete: async () => WRITER },
      assessor: {
        modelVersion: "synthetic/normal-assessor",
        complete: async () => "No faults found.\nEND OF ASSESSMENT",
      },
      judge: { modelVersion: "synthetic/normal-judge", complete: async () => REVISE },
    });
    const loop = await runEditorialLoop({
      stages,
      policy: { version: "assess-judge-v1", maxRevisions: 1, deadlineMs: 120000 },
      draft: parent.version.draft,
      package: parent.pkgRef,
      sourceUrl: normal.input.sourceUrl,
      attemptId: "normal-policy-fixture",
      now: async () => Date.now(),
      step: async (_name, work) => work(),
      progress: async () => {},
      save: async (history) => writeOnce(content, "editorial-loops/normal-fixture.json", history),
    });
    const judgment = JSON.parse(await content.read(loop.history.judgments.at(-1)!));
    const f = { request: { body: artifactReference(loop.draft) } };
    const real = localDraftDestination();
    const destinations = [
      new SimulatedDestination("dummy-a", "draft"),
      new SimulatedDestination("dummy-b", "draft"),
      real.destination,
    ];
    const checkpoint = {
      version: "normal-editorial-draft-checkpoint-v1",
      workflowKey: normal.identity.workflowKey,
      input: normal.input,
      inputHash: articleAttemptHash(normal.input),
      body: artifactReference(loop.draft),
      metadata: artifactReference(loop.metadata),
      publication: judgment.publication,
      package: artifactReference(parent.pkgRef),
      assessment: artifactReference(loop.history.assessments.at(-1)!),
      judgment: artifactReference(loop.history.judgments.at(-1)!),
      mechanicalRun: artifactReference(loop.history.mechanicalRuns.at(-1)!),
      sourceContext: pkg.source.context,
      initial: {
        body: artifactReference(loop.history.initial.draft),
        metadata: artifactReference(loop.history.initial.metadata),
      },
      assessments: loop.history.assessments.map(artifactReference),
      judgments: loop.history.judgments.map(artifactReference),
      revisions: loop.history.revisions.map((v) => ({
        body: artifactReference(v.draft),
        metadata: artifactReference(v.metadata),
      })),
      mechanicalRuns: loop.history.mechanicalRuns.map(artifactReference),
      appliedPolicy: {
        version: "live-editorial-policy-v1",
        revision: "config-sha256:" + "a".repeat(32),
        policy: {
          version: "assess-judge-v1",
          maxRevisions: 1,
          deadlineMs: 120000,
          onExhausted: "create-unpublished-draft",
        },
      },
    };
    const args = {
      checkpoint,
      destinations: destinations.map((d) => d.draftTarget),
      content,
      operations,
      deliveryControl: real.control,
    };
    const beforeInvalid = await content.list("configured-draft-checkpoints", 100);
    await expect(
      authorizeConfiguredDraft({
        ...args,
        checkpoint: {
          ...checkpoint,
          input: { ...checkpoint.input, syntheticSensitive: "DO-NOT-PERSIST-SENTINEL" },
        },
      }),
    ).rejects.toThrow();
    expect(await content.list("configured-draft-checkpoints", 100)).toEqual(beforeInvalid);
    await expect(
      authorizeConfiguredDraft({
        ...args,
        checkpoint: {
          ...checkpoint,
          appliedPolicy: {
            ...checkpoint.appliedPolicy,
            policy: { ...checkpoint.appliedPolicy.policy, onExhausted: "stop" },
          },
        },
      }),
    ).rejects.toThrow();
    expect(
      operations.ownerDraftIntent(
        normal.input.publicationId,
        normal.input.postId,
        normal.input.operatorRequestId!,
      ),
    ).toBeUndefined();
    const unavailable = new Proxy(content, {
      get(target, key) {
        if (key === "read")
          return async (ref: Parameters<GitArtifactStore["read"]>[0]) => {
            if (ref.path === checkpoint.metadata.path) throw new ArtifactStoreError("git-failed");
            return target.read(ref);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(authorizeConfiguredDraft({ ...args, content: unavailable })).rejects.toMatchObject(
      { code: "git-failed" },
    );
    expect(
      operations.ownerDraftIntent(
        normal.input.publicationId,
        normal.input.postId,
        normal.input.operatorRequestId!,
      ),
    ).toBeUndefined();
    const authorized = await authorizeConfiguredDraft(args);
    expect(authorized.outcome).toBe("owner-authorized-draft");
    expect((await authorizeConfiguredDraft(args)).eventId).toBe(authorized.eventId);
    const evidence = await readApprovalEvidence(
      content,
      authorized.authorization,
      "owner-draft-rehearsal",
      operations,
    );
    expect(evidence.authorizationOutcome).toBe("owner-authorized-draft");
    expect(evidence.body).toEqual(f.request.body);
    const event = operations.pendingEvent(authorized.eventId)!;
    for (const destination of destinations) {
      const result = await handleApprovedArticle({
        payload: event.payload,
        destination,
        content,
        operations,
        deliveryControl: real.control,
        schedule: { delayMs: 0 },
        owner: "fixture",
      });
      expect(result.action).toBe("ack");
    }
    expect(real.calls.create).toBe(1);
    const forged = JSON.parse(event.payload);
    forged.data.draftTargets[2].identity = "sha256:" + "f".repeat(64);
    expect(
      (
        await handleApprovedArticle({
          payload: JSON.stringify(forged),
          destination: real.destination,
          content,
          operations,
          deliveryControl: real.control,
          schedule: { delayMs: 0 },
          owner: "fixture",
        })
      ).action,
    ).toBe("term");
    expect(real.calls.create).toBe(1);
    const current = (await content.lookup(checkpoint.metadata.path))!;
    const editedMetadata = JSON.parse(await content.read(current));
    editedMetadata.draftedAt = "2026-02-01T00:00:00.000Z";
    await content.revise(current.path, JSON.stringify(editedMetadata), current.sha256);
    const staleAttempt = recordArticleAttempt(operations, normal.input, "normal-stale-proof");
    await expect(
      authorizeConfiguredDraft({
        ...args,
        checkpoint: {
          ...checkpoint,
          input: staleAttempt.input,
          inputHash: articleAttemptHash(staleAttempt.input),
          workflowKey: staleAttempt.identity.workflowKey,
        },
      }),
    ).rejects.toMatchObject({ code: "stale-base" });
    expect(
      operations.ownerDraftIntent(
        normal.input.publicationId,
        normal.input.postId,
        "normal-stale-proof",
      ),
    ).toBeUndefined();
  },
);
