import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vite-plus/test";
import { NatsController, confirmNatsAck } from "../../src/controllers/nats.js";
import {
  provisionDiscoveryStream,
  provisionDurableConsumer,
} from "../../src/controllers/nats-provision.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { ARTICLE_APPROVED_SUBJECT } from "../../src/events/article-approved-event.js";
import {
  recordApproval,
  handleApprovedArticle,
  SimulatedDestination,
} from "../../src/publishing/approved-article.js";
import { dispatchApprovedArticles } from "../../src/publishing/approval-dispatch.js";
import { runSelectedPublisher } from "../../src/publishing/selected-publisher.js";
import { SubstackDraftDestination } from "../../src/publishing/substack/destination.js";
import {
  SubstackError,
  type NewDraft,
  type SubstackDraft,
} from "../../src/publishing/substack/client.js";
import { approvedReport } from "./approval-fixtures.js";

let container: StartedTestContainer, nats: NatsController;
let dir: string, content: GitArtifactStore, operations: OperationStore;
const stream = "SELECTED_TEST";
beforeAll(async () => {
  container = await new GenericContainer("nats:2.10.22")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  nats = new NatsController(`nats://${container.getHost()}:${container.getMappedPort(4222)}`);
  await nats.connect("selected-publisher-test");
}, 120000);
afterAll(async () => {
  await nats?.close();
  await container?.stop();
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "selected-publisher-"));
  await mkdir(join(dir, "content"));
  content = new GitArtifactStore({ repoPath: join(dir, "content"), repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
  await provisionDiscoveryStream(nats, { name: stream, subjects: [ARTICLE_APPROVED_SUBJECT] });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
  await (await nats.manager()).streams.delete(stream);
});

async function approved(dummyProof = true) {
  const report = await approvedReport(content);
  const { eventId } = await recordApproval({ content, operations, report });
  const payload = operations.pendingEvent(eventId)!.payload;
  if (dummyProof)
    for (const name of ["dummy-a", "dummy-b"]) {
      expect(
        await handleApprovedArticle({
          content,
          operations,
          payload,
          owner: name,
          destination: new SimulatedDestination(name, "draft"),
          schedule: { delayMs: 0 },
        }),
      ).toMatchObject({ action: "ack" });
    }
  let sequence = 0;
  await dispatchApprovedArticles({
    operations,
    publisher: {
      publish: async (subject, data, options) => {
        const result = await nats.publish(subject, data, options);
        sequence = result.seq;
        return result;
      },
    },
  });
  return { eventId, payload, sequence };
}
function destination(uncertain = false) {
  const drafts: SubstackDraft[] = [];
  let creates = 0;
  const adapter = new SubstackDraftDestination({
    listDrafts: async () => drafts,
    createDraft: async (input: NewDraft) => {
      creates++;
      drafts.push({
        id: "101",
        draft_title: input.title,
        draft_subtitle: input.subtitle,
        draft_body: JSON.stringify(input.body),
        is_published: false,
        draft_created_at: new Date().toISOString(),
      });
      if (uncertain) throw new SubstackError("uncertain");
      return { id: "101" };
    },
    getDraft: async () => drafts[0]!,
  });
  return {
    adapter,
    drafts,
    get creates() {
      return creates;
    },
  };
}
const run = (
  selection: { eventId: string; sequence: number; waitMs?: number },
  target: ReturnType<typeof destination>,
  transport = nats,
) =>
  runSelectedPublisher({
    selection: {
      waitMs: selection.waitMs ?? 3000,
      eventId: selection.eventId,
      sequence: selection.sequence,
    },
    nats: transport,
    stream,
    content,
    operations,
    destination: target.adapter,
    owner: "selected-test",
    retryDelayMs: 1,
  });

describe("selected publisher through real NATS", { timeout: 120000 }, () => {
  it("handles only the retained selected event and ACKs before returning, then reconnects without another create", async () => {
    await provisionDurableConsumer(nats, {
      stream,
      name: "continuous",
      filterSubject: ARTICLE_APPROVED_SUBJECT,
    });
    await nats.publish(
      ARTICLE_APPROVED_SUBJECT,
      new TextEncoder().encode('{"unrelated":"before"}'),
      { msgId: "before" },
    );
    const selected = await approved();
    await nats.publish(
      ARTICLE_APPROVED_SUBJECT,
      new TextEncoder().encode('{"unrelated":"after"}'),
      { msgId: "after" },
    );
    const target = destination();
    const first = await run(selected, target);
    expect(first.status).toBe("delivered");
    expect(target.creates).toBe(1);
    expect(target.drafts[0]!.is_published).toBe(false);
    expect(await nats.consumerPosition(stream, first.consumer)).toMatchObject({
      ackFloorSequence: selected.sequence,
      pending: 1,
      ackPending: 0,
    });
    expect(await nats.consumerPosition(stream, "continuous")).toMatchObject({
      deliveredSequence: 0,
      pending: 3,
      ackPending: 0,
    });
    const replay = await run(selected, target);
    expect(replay).toMatchObject({ status: "reused", consumer: first.consumer });
    expect(target.creates).toBe(1);
  });

  it("refuses a wrong sequence/event before provisioning or destination effects", async () => {
    const selected = await approved(),
      target = destination();
    await nats.publish(ARTICLE_APPROVED_SUBJECT, new TextEncoder().encode('{"unrelated":true}'), {
      msgId: "wrong",
    });
    const before = (await (await nats.manager()).consumers.list(stream).next()).length;
    await expect(
      run({ ...selected, sequence: selected.sequence + 1 }, target),
    ).rejects.toMatchObject({ code: "selection-mismatch" });
    await expect(run({ ...selected, eventId: "another-event" }, target)).rejects.toMatchObject({
      code: "not-dispatched",
    });
    expect((await (await nats.manager()).consumers.list(stream).next()).length).toBe(before);
    expect(target.creates).toBe(0);
  });

  it("requires both dummy proofs before scoped consumer creation", async () => {
    const selected = await approved(false),
      target = destination();
    await expect(run(selected, target)).rejects.toMatchObject({ code: "dummy-proof-missing" });
    expect((await (await nats.manager()).consumers.list(stream).next()).length).toBe(0);
    expect(target.creates).toBe(0);
  });

  it("does not ACK, NAK or terminate a mismatched delivered message", async () => {
    const selected = await approved(),
      target = destination();
    const controls = { ack: 0, nak: 0, term: 0 };
    const transport = {
      readMessage: nats.readMessage.bind(nats),
      consumerPosition: nats.consumerPosition.bind(nats),
      manager: nats.manager.bind(nats),
      consume: (
        s: string,
        c: string,
        handler: Parameters<NatsController["consume"]>[2],
        signal: AbortSignal,
      ) =>
        nats.consume(
          s,
          c,
          (message) =>
            handler({
              ...message,
              data: new TextEncoder().encode('{"unrelated":true}'),
              ack: async () => {
                controls.ack++;
                await message.ack();
              },
              nak: (d) => {
                controls.nak++;
                message.nak(d);
              },
              term: () => {
                controls.term++;
                message.term();
              },
            }),
          signal,
        ),
    };
    const result = await runSelectedPublisher({
      selection: { ...selected, payload: undefined, waitMs: 3000 },
      nats: transport,
      stream,
      content,
      operations,
      destination: target.adapter,
      owner: "test",
    }).catch((error) => error);
    // Strict input refuses extra keys before setup as well.
    expect(result).toMatchObject({ code: "invalid-input" });
    const actual = await runSelectedPublisher({
      selection: { eventId: selected.eventId, sequence: selected.sequence, waitMs: 3000 },
      nats: transport,
      stream,
      content,
      operations,
      destination: target.adapter,
      owner: "test",
    });
    expect(actual).toMatchObject({ status: "stopped", reason: "selection-mismatch" });
    expect(controls).toEqual({ ack: 0, nak: 0, term: 0 });
    expect(target.creates).toBe(0);
    expect(await nats.consumerPosition(stream, actual.consumer)).toMatchObject({
      ackPending: 1,
      ackFloorSequence: 0,
    });
  });

  it("times out without a destination effect if the retained message disappears before consumption", async () => {
    const selected = await approved(),
      target = destination();
    const transport = {
      readMessage: nats.readMessage.bind(nats),
      consumerPosition: nats.consumerPosition.bind(nats),
      manager: nats.manager.bind(nats),
      consume: async (...args: Parameters<NatsController["consume"]>) => {
        await (await nats.manager()).streams.deleteMessage(stream, selected.sequence);
        return nats.consume(...args);
      },
    };
    const result = await runSelectedPublisher({
      selection: { eventId: selected.eventId, sequence: selected.sequence, waitMs: 200 },
      nats: transport,
      stream,
      content,
      operations,
      destination: target.adapter,
      owner: "test",
    });
    expect(result).toMatchObject({ status: "stopped", reason: "timeout" });
    expect(target.creates).toBe(0);
  });

  it.each(["false", "throw"])(
    "keeps ACK %s uncertain and reconnects from the broker receipt without another create",
    async (mode) => {
      const selected = await approved(),
        target = destination();
      const transport = {
        readMessage: nats.readMessage.bind(nats),
        consumerPosition: nats.consumerPosition.bind(nats),
        manager: nats.manager.bind(nats),
        consume: (
          s: string,
          c: string,
          handler: Parameters<NatsController["consume"]>[2],
          signal: AbortSignal,
          options?: { once: boolean },
        ) =>
          nats.consume(
            s,
            c,
            (message) =>
              handler({
                ...message,
                ack: () =>
                  confirmNatsAck({
                    ackAck: async () => {
                      await message.ack();
                      if (mode === "throw") throw new Error("synthetic transport diagnostic");
                      return false;
                    },
                  }),
              }),
            signal,
            options,
          ),
      };
      const first = await runSelectedPublisher({
        selection: { eventId: selected.eventId, sequence: selected.sequence, waitMs: 3000 },
        nats: transport,
        stream,
        content,
        operations,
        destination: target.adapter,
        owner: "test",
      });
      expect(first).toMatchObject({ status: "stopped", reason: "ack-uncertain" });
      expect(target.creates).toBe(1);
      expect(await run(selected, target)).toMatchObject({
        status: "reused",
        consumer: first.consumer,
      });
      expect(target.creates).toBe(1);
    },
  );

  it("does not ACK a simulated same-name receipt as a real destination delivery", async () => {
    const selected = await approved(),
      target = destination();
    expect(
      await handleApprovedArticle({
        content,
        operations,
        payload: selected.payload,
        owner: "synthetic",
        destination: new SimulatedDestination("substack", "draft"),
        schedule: { delayMs: 0 },
      }),
    ).toMatchObject({ action: "ack" });
    const result = await run(selected, target);
    expect(result).toMatchObject({ status: "stopped", reason: "receipt-mismatch" });
    expect(target.creates).toBe(0);
    expect(await nats.consumerPosition(stream, result.consumer)).toMatchObject({
      ackFloorSequence: 0,
      ackPending: 1,
    });
    // An adversarial ACK-position snapshot still cannot turn simulation into real proof.
    const transport = {
      readMessage: nats.readMessage.bind(nats),
      manager: nats.manager.bind(nats),
      consume: nats.consume.bind(nats),
      consumerPosition: async () => ({
        pending: 0,
        ackPending: 0,
        deliveredSequence: selected.sequence,
        ackFloorSequence: selected.sequence,
      }),
    };
    await expect(
      runSelectedPublisher({
        selection: { eventId: selected.eventId, sequence: selected.sequence, waitMs: 3000 },
        nats: transport,
        stream,
        content,
        operations,
        destination: target.adapter,
        owner: "test",
      }),
    ).rejects.toThrow(/receipt/);
  });

  it("waits across empty one-second fetches for selected delayed redelivery", async () => {
    const selected = await approved(),
      target = destination(true);
    const first = await runSelectedPublisher({
      selection: { eventId: selected.eventId, sequence: selected.sequence, waitMs: 4000 },
      nats,
      stream,
      content,
      operations,
      destination: target.adapter,
      owner: "test",
      retryDelayMs: 1600,
    });
    expect(first).toMatchObject({ status: "stopped", reason: "pending" });
    const began = Date.now();
    const second = await run(selected, target);
    expect(second).toMatchObject({ status: "delivered", consumer: first.consumer });
    expect(Date.now() - began).toBeGreaterThan(1000);
    expect(target.creates).toBe(1);
  });

  it("keeps the original total receive deadline while waiting for later redelivery", async () => {
    const selected = await approved(),
      target = destination(true);
    const first = await runSelectedPublisher({
      selection: { eventId: selected.eventId, sequence: selected.sequence, waitMs: 4000 },
      nats,
      stream,
      content,
      operations,
      destination: target.adapter,
      owner: "test",
      retryDelayMs: 5000,
    });
    expect(first).toMatchObject({ status: "stopped", reason: "pending" });
    const began = Date.now();
    const second = await run({ ...selected, waitMs: 1200 }, target);
    expect(second).toMatchObject({
      status: "stopped",
      reason: "timeout",
      consumer: first.consumer,
    });
    expect(Date.now() - began).toBeGreaterThanOrEqual(1000);
    expect(Date.now() - began).toBeLessThan(4500);
    expect(target.creates).toBe(1);
    expect(await nats.consumerPosition(stream, first.consumer)).toMatchObject({
      ackFloorSequence: 0,
    });
  });

  it("reconciles an uncertain create on the same consumer/event without a second draft", async () => {
    const selected = await approved(),
      target = destination(true);
    const first = await run(selected, target);
    expect(first).toMatchObject({ status: "stopped", reason: "pending" });
    expect(target.creates).toBe(1);
    const second = await run(selected, target);
    expect(second).toMatchObject({ status: "delivered", consumer: first.consumer });
    expect(target.creates).toBe(1);
    expect(await nats.consumerPosition(stream, first.consumer)).toMatchObject({
      ackFloorSequence: selected.sequence,
      ackPending: 0,
    });
  });
});
