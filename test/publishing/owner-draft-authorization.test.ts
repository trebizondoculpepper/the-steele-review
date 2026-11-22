import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore, ArtifactStoreError } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  OwnerDraftAuthorizationSchema,
  OwnerDraftRequestSchema,
  ownerDraftRequestHash,
  ownerDraftVersionIdentity,
} from "../../src/content/owner-draft-authorization.js";
import { authorizeOwnerDraftRehearsal } from "../../src/publishing/owner-draft-rehearsal.js";
import {
  approvalEventFor,
  handleApprovedArticle,
  SimulatedDestination,
  readDummyDeliveryProof,
  readDestinationDeliveryProof,
} from "../../src/publishing/approved-article.js";
import { SubstackDraftDestination } from "../../src/publishing/substack/destination.js";
import { artifactReference } from "../../src/drafting/publication-payload.js";
import { readRetainedDraftRehearsal } from "../../src/drafting/draft-rehearsal.js";
import { writeOnce } from "../../src/research/job.js";
import { ARTICLE_APPROVED_SUBJECT } from "../../src/events/article-approved-event.js";
import { retainedRehearsalFixture } from "./draft-rehearsal-fixtures.js";
import type { SubstackDraft, NewDraft } from "../../src/publishing/substack/client.js";

let dir: string, content: GitArtifactStore, operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "owner-authorization-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

export function localDraftDestination() {
  const records: SubstackDraft[] = [],
    calls = { create: 0, get: 0, list: 0 };
  const client = {
    draftTargetIdentity: `sha256:${"f".repeat(64)}`,
    createDraft: async (input: NewDraft) => {
      calls.create++;
      const draft = {
        id: String(records.length + 1),
        draft_title: input.title,
        draft_subtitle: input.subtitle ?? "",
        draft_body: JSON.stringify(input.body),
        is_published: false,
        email_sent_at: null,
      };
      records.push(draft);
      return { id: draft.id };
    },
    getDraft: async (id: string) => {
      calls.get++;
      const found = records.find((r) => r.id === id);
      if (!found) throw new Error("synthetic absent draft");
      return found;
    },
    listDrafts: async () => {
      calls.list++;
      return [...records];
    },
  };
  return { client, records, calls, destination: new SubstackDraftDestination(client) };
}
const complete = (f: Awaited<ReturnType<typeof retainedRehearsalFixture>>) => ({
  read: async () => ({
    state: "completed" as const,
    result: {
      version: "editorial-judge-recovery-result-v1" as const,
      outcome: "rejected" as const,
      summary: f.summaryRef,
      draft: f.loop.draft,
      metadata: f.loop.metadata,
      completedAt: "2026-01-03T00:00:00.000Z",
    },
  }),
});

describe(
  "explicit owner draft authorization through the shared consumer",
  { timeout: 240000 },
  () => {
    it("records honest authority, reuses one exact draft and refuses forged targets or drift even with cached receipts", async () => {
      const f = await retainedRehearsalFixture(content, operations),
        real = localDraftDestination();
      const destinations = [
        new SimulatedDestination("dummy-a", "draft"),
        new SimulatedDestination("dummy-b", "draft"),
        real.destination,
      ];
      const request = OwnerDraftRequestSchema.parse({
        ...f.request,
        destinations: destinations.map((d) => d.draftTarget),
      });
      const args = { request, content, operations, parentCompletion: complete(f), destinations };
      const result = await authorizeOwnerDraftRehearsal(args);
      expect(result.outcome).toBe("owner-authorized-draft");
      expect((await authorizeOwnerDraftRehearsal(args)).eventId).toBe(result.eventId);
      expect(real.calls.create).toBe(0);
      expect(f.calls).toEqual({ writer: 1, assessor: 1, judge: 2 });
      const pending = operations.pendingEvent(result.eventId)!;
      const article = JSON.parse(pending.payload).data;
      const deliver = (destination = real.destination, payload = pending.payload) =>
        handleApprovedArticle({
          payload,
          destination,
          schedule: { delayMs: 0 },
          content,
          operations,
          owner: "synthetic-owner",
        });
      for (const destination of destinations.slice(0, 2))
        expect(
          (
            await handleApprovedArticle({
              payload: pending.payload,
              destination,
              schedule: { delayMs: 0 },
              content,
              operations,
              owner: "dummy-owner",
            })
          ).action,
        ).toBe("ack");
      expect(await readDummyDeliveryProof(content, article, operations)).toBeDefined();
      expect((await deliver()).action).toBe("ack");
      expect(real.calls.create).toBe(1);
      expect((await deliver()).action).toBe("ack");
      expect(real.calls.create).toBe(1);
      const receiptRef = await readDestinationDeliveryProof(
        content,
        article,
        real.destination,
        false,
        operations,
      );
      const receipt = JSON.parse(await content.read(receiptRef!));
      expect(receipt).toMatchObject({
        simulated: false,
        approvalKind: "owner-draft-rehearsal",
        authorizationOutcome: "owner-authorized-draft",
        draftSafety: { unpublished: true, emailTimestampAbsent: true },
      });
      expect(real.records[0]).toMatchObject({ is_published: false, email_sent_at: null });
      const altered = JSON.parse(pending.payload);
      altered.data.draftTargets[2].identity = `sha256:${"0".repeat(64)}`;
      expect(await deliver(real.destination, JSON.stringify(altered))).toMatchObject({
        action: "term",
        reason: "approval-mismatch",
      });
      const drift = new SubstackDraftDestination({
        ...real.client,
        draftTargetIdentity: `sha256:${"e".repeat(64)}`,
      });
      expect(await deliver(drift)).toMatchObject({ action: "term", reason: "approval-mismatch" });
      expect(real.calls.create).toBe(1);
      const retained = JSON.parse(await content.read(f.summaryRef));
      expect(retained.outcome).toBe("rejected");
      await expect(
        authorizeOwnerDraftRehearsal({
          ...args,
          request: { ...request, requestId: "competing-owner" },
        }),
      ).rejects.toThrow();
    });

    it("terminates permanent invalid evidence but retries operational storage failure without destination effects", async () => {
      const f = await retainedRehearsalFixture(content, operations),
        real = localDraftDestination();
      const destinations = [
        new SimulatedDestination("dummy-a", "draft"),
        new SimulatedDestination("dummy-b", "draft"),
        real.destination,
      ];
      const request = OwnerDraftRequestSchema.parse({
        ...f.request,
        destinations: destinations.map((d) => d.draftTarget),
      });
      const checked = await readRetainedDraftRehearsal({ request, content, operations });
      // Simulate a hash-valid but inconsistent coordinator artifact. Delivery must revalidate it.
      const bad = OwnerDraftRequestSchema.parse({
        ...request,
        mechanicalRun:
          f.denied.raw.mechanicalRuns[0] && artifactReference(f.denied.raw.mechanicalRuns[0]),
      });
      const binding = operations.recordOwnerDraftIntent({
        ...checked.post,
        requestId: bad.requestId,
        requestHash: ownerDraftRequestHash(bad),
        versionIdentity: ownerDraftVersionIdentity(bad),
      });
      const record = OwnerDraftAuthorizationSchema.parse({
        kind: "owner-draft-rehearsal",
        outcome: "owner-authorized-draft",
        request: bad,
        post: checked.post,
        parentOutcome: "rejected",
        adoptedRevisionCount: 1,
        authorizedAt: binding.recordedAt,
      });
      const ref = await writeOnce(content, "owner-draft-rehearsals/synthetic-invalid.json", record);
      const event = approvalEventFor(
        {
          kind: "owner-draft-rehearsal",
          post: checked.post,
          body: request.body,
          package: request.package,
          publication: request.publication,
          assessment: request.assessment,
          approvedAt: binding.recordedAt,
          markdown: checked.markdown,
          payload: checked.payload,
          draftTargets: request.destinations,
          authorizationOutcome: "owner-authorized-draft",
        },
        ref,
      );
      const payload = JSON.stringify(event.event.toJSON());
      operations.completeOwnerDraftAuthorization({
        binding,
        authorization: artifactReference(ref),
        event: { eventId: event.eventId, subject: ARTICLE_APPROVED_SUBJECT, payload },
      });
      const input = {
        payload,
        destination: real.destination,
        schedule: { delayMs: 0 },
        content,
        operations,
        owner: "synthetic",
      };
      expect(await handleApprovedArticle(input)).toMatchObject({
        action: "term",
        reason: "approval-mismatch",
      });
      const unavailable = new Proxy(content, {
        get(target, key) {
          if (key === "read")
            return async (...args: Parameters<GitArtifactStore["read"]>) => {
              if (args[0].path === request.parent.summary.path)
                throw new ArtifactStoreError("git-failed");
              return target.read(...args);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      expect(await handleApprovedArticle({ ...input, content: unavailable })).toMatchObject({
        action: "nak",
        reason: "retry",
      });
      expect(real.calls).toEqual({ create: 0, get: 0, list: 0 });
    });
  },
);
