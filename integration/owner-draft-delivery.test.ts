/** Explicit integration fixture: isolated real NATS, Git and state; synthetic models/Substack. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { beforeAll, afterAll, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../src/controllers/artifact-store.js";
import { OperationStore } from "../src/controllers/operation-store.js";
import { NatsController } from "../src/controllers/nats.js";
import {
  provisionDiscoveryStream,
  provisionDurableConsumer,
} from "../src/controllers/nats-provision.js";
import { OwnerDraftRequestSchema } from "../src/content/owner-draft-authorization.js";
import {
  ARTICLE_APPROVED_SUBJECT,
  ARTICLE_DRAFT_AUTHORIZED_EVENT_TYPE_V2,
} from "../src/events/article-approved-event.js";
import { authorizeOwnerDraftRehearsal } from "../src/publishing/owner-draft-rehearsal.js";
import { dispatchApprovedArticles } from "../src/publishing/approval-dispatch.js";
import {
  SimulatedDestination,
  readDummyDeliveryProof,
  readDestinationDeliveryProof,
} from "../src/publishing/approved-article.js";
import {
  runPublisherService,
  type SelectedPublisherResult,
} from "../src/publishing/publisher-service.js";
import { runSelectedPublisher } from "../src/publishing/selected-publisher.js";
import { SubstackError } from "../src/publishing/substack/client.js";
import { retainedRehearsalFixture } from "./draft-rehearsal-fixtures.js";
import { localDraftDestination } from "../test/publishing/draft-destination-fixture.js";

let server: StartedTestContainer, nats: NatsController;
beforeAll(async () => {
  server = await new GenericContainer("nats:2.10.22")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  nats = new NatsController(`nats://${server.getHost()}:${server.getMappedPort(4222)}`);
  await nats.connect("owner-draft-integration");
}, 120000);
afterAll(async () => {
  await nats?.close();
  await server?.stop();
});

describe(
  "one owner draft through real NATS and the actual shared consumers",
  { timeout: 240000 },
  () => {
    it("recovers durable authorization and uncertain creation, ACKs both dummies and one real-adapter receipt, and leaves unrelated messages alone", async () => {
      const dir = await mkdtemp(join(tmpdir(), "owner-nats-")),
        content = new GitArtifactStore({ repoPath: dir, repository: "content" });
      await content.initialise();
      const operations = new OperationStore({ path: join(dir, "state.sqlite") }),
        stream = "OWNER_DRAFT_TEST";
      try {
        await provisionDiscoveryStream(nats, {
          name: stream,
          subjects: [ARTICLE_APPROVED_SUBJECT],
        });
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
        const parentCompletion = {
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
        };
        let lost = true;
        const interrupted = new Proxy(operations, {
          get(target, key) {
            if (key === "completeOwnerDraftAuthorization")
              return (...args: Parameters<OperationStore["completeOwnerDraftAuthorization"]>) => {
                target.completeOwnerDraftAuthorization(...args);
                if (lost) {
                  lost = false;
                  throw new Error("synthetic lost authorization acknowledgement");
                }
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const args = { request, content, operations, parentCompletion, destinations };
        await expect(
          authorizeOwnerDraftRehearsal({ ...args, operations: interrupted }),
        ).rejects.toThrow("lost authorization acknowledgement");
        expect(operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)).toHaveLength(1);
        const authorized = await authorizeOwnerDraftRehearsal(args);
        expect(authorized).toMatchObject({ outcome: "owner-authorized-draft", repeated: true });
        expect(operations.duePendingEvents(10, ARTICLE_APPROVED_SUBJECT)).toHaveLength(1);
        const pending = operations.pendingEvent(authorized.eventId)!;
        expect(JSON.parse(pending.payload).type).toBe(ARTICLE_DRAFT_AUTHORIZED_EVENT_TYPE_V2);
        const before = await nats.publish(
          ARTICLE_APPROVED_SUBJECT,
          new TextEncoder().encode('{"unrelated":"before"}'),
          { msgId: "unrelated-before" },
        );
        let sequence = 0;
        expect(
          await dispatchApprovedArticles({
            operations,
            publisher: {
              publish: async (subject, data, options) => {
                const receipt = await nats.publish(subject, data, options);
                sequence = receipt.seq;
                return receipt;
              },
            },
          }),
        ).toMatchObject({ sent: 1, retrying: 0 });
        const after = await nats.publish(
          ARTICLE_APPROVED_SUBJECT,
          new TextEncoder().encode('{"unrelated":"after"}'),
          { msgId: "unrelated-after" },
        );
        for (const destination of destinations.slice(0, 2)) {
          await provisionDurableConsumer(nats, {
            stream,
            name: destination.name,
            filterSubject: ARTICLE_APPROVED_SUBJECT,
            startSequence: sequence,
            maxAckPending: 1,
          });
          let result: SelectedPublisherResult | undefined;
          await runPublisherService({
            nats,
            stream,
            consumer: destination.name,
            destination,
            content,
            operations,
            deliveryControl: real.control,
            owner: destination.name,
            delayMs: 0,
            retryDelayMs: 1,
            log: () => {},
            signal: AbortSignal.timeout(15000),
            selection: {
              eventId: authorized.eventId,
              sequence,
              payload: pending.payload,
              onResult: (value) => {
                result = value;
              },
            },
          });
          expect(result?.status).toBe("delivered");
          expect((await nats.consumerPosition(stream, destination.name)).ackFloorSequence).toBe(
            sequence,
          );
        }
        const article = JSON.parse(pending.payload).data;
        expect(await readDummyDeliveryProof(content, article, operations)).toBeDefined();
        const create = real.client.createDraft;
        real.client.createDraft = async (input) => {
          await create(input);
          throw new SubstackError("uncertain");
        };
        const run = () =>
          runSelectedPublisher({
            selection: { eventId: authorized.eventId, sequence, waitMs: 10000 },
            nats,
            stream,
            content,
            operations,
            deliveryControl: real.control,
            destination: real.destination,
            owner: "selected-owner",
            retryDelayMs: 1,
          });
        expect(await run()).toMatchObject({ status: "stopped", reason: "pending" });
        expect(real.calls.create).toBe(1);
        real.policy.allowed = false;
        await expect(run()).rejects.toMatchObject({ code: "delivery-paused" });
        real.policy.allowed = true;
        const delivered = await run();
        expect(delivered.status).toBe("delivered");
        expect((await run()).status).toBe("reused");
        expect(real.calls.create).toBe(1);
        const proof = await readDestinationDeliveryProof(
          content,
          article,
          real.destination,
          false,
          operations,
        );
        expect(proof).toBeDefined();
        expect(JSON.parse(await content.read(proof!))).toMatchObject({
          approvalKind: "owner-draft-rehearsal",
          authorizationOutcome: "owner-authorized-draft",
          simulated: false,
          draftSafety: { unpublished: true, emailTimestampAbsent: true },
        });
        expect(real.records).toHaveLength(1);
        expect(real.records[0]).toMatchObject({ is_published: false, email_sent_at: null });
        expect(new TextDecoder().decode((await nats.readMessage(stream, before.seq)).data)).toBe(
          '{"unrelated":"before"}',
        );
        expect(new TextDecoder().decode((await nats.readMessage(stream, after.seq)).data)).toBe(
          '{"unrelated":"after"}',
        );
        expect(f.calls).toEqual({ writer: 1, assessor: 1, judge: 2 });
        expect(JSON.parse(await content.read(f.summaryRef)).outcome).toBe("rejected");
      } finally {
        operations.close();
        await (await nats.manager()).streams.delete(stream).catch(() => {});
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
);
