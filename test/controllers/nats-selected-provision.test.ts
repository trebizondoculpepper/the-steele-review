import { it, expect } from "vite-plus/test";
import type { NatsController } from "../../src/controllers/nats.js";
import {
  ConsumerConflictError,
  provisionDurableConsumer,
} from "../../src/controllers/nats-provision.js";
it("validates explicit start policy before broker access and refuses an incompatible existing consumer", async () => {
  let calls = 0;
  const nats = {
    manager: async () => {
      calls++;
      throw new Error("must not connect");
    },
  } as Pick<NatsController, "manager">;
  for (const config of [
    { startSequence: 0 },
    { startSequence: 1.5 },
    { startSequence: 1, newOnly: true },
  ]) {
    await expect(
      provisionDurableConsumer(nats, {
        stream: "S",
        name: "selected",
        filterSubject: "a.b",
        ...config,
      }),
    ).rejects.toThrow("invalid consumer start sequence");
  }
  expect(calls).toBe(0);
  const existing = {
    manager: async () => ({
      consumers: {
        info: async () => ({
          config: {
            filter_subject: "a.b",
            ack_policy: "explicit",
            deliver_policy: "by_start_sequence",
            opt_start_seq: 4,
          },
        }),
      },
    }),
  } as unknown as Pick<NatsController, "manager">;
  await expect(
    provisionDurableConsumer(existing, {
      stream: "S",
      name: "selected",
      filterSubject: "a.b",
      startSequence: 5,
    }),
  ).rejects.toBeInstanceOf(ConsumerConflictError);
});

it("refuses invalid or wider outstanding-delivery policies without modifying a consumer", async () => {
  let calls = 0;
  const offline = {
    manager: async () => {
      calls++;
      throw new Error("must not connect");
    },
  } as Pick<NatsController, "manager">;
  await expect(
    provisionDurableConsumer(offline, {
      stream: "S",
      name: "selected",
      filterSubject: "a.b",
      maxAckPending: 0,
    }),
  ).rejects.toThrow("invalid consumer max ack pending");
  expect(calls).toBe(0);
  let updates = 0;
  const existing = {
    manager: async () => ({
      consumers: {
        info: async () => ({
          config: {
            filter_subject: "a.b",
            ack_policy: "explicit",
            deliver_policy: "by_start_sequence",
            opt_start_seq: 4,
            max_ack_pending: 1000,
          },
        }),
        update: async () => {
          updates++;
        },
      },
    }),
  } as unknown as Pick<NatsController, "manager">;
  await expect(
    provisionDurableConsumer(existing, {
      stream: "S",
      name: "selected",
      filterSubject: "a.b",
      startSequence: 4,
      maxAckPending: 1,
    }),
  ).rejects.toBeInstanceOf(ConsumerConflictError);
  expect(updates).toBe(0);
});
