import { expect, it } from "vite-plus/test";
import {
  CAPTURE_BRIDGE_MAX_DELIVER,
  settleCapturedDelivery,
} from "../../src/workflow/captured-bridge.js";

const decision = {
  action: "nak",
  reason: "submission-failed",
  delayMs: 30_000,
  key: "fixture/post@revision",
} as const;

it("retries before the limit and durably records failure before the last acknowledgement", async () => {
  const actions: string[] = [];
  const message = {
    deliveryCount: CAPTURE_BRIDGE_MAX_DELIVER - 1,
    ack: async () => {
      actions.push("ack");
    },
    nak: (delay?: number) => actions.push(`nak:${delay}`),
    term: () => actions.push("term"),
  };
  const state = {
    recordPermanentFailure: (key: string, code: string) => actions.push(`${key}=${code}`),
  };
  await settleCapturedDelivery(message, decision, state);
  expect(actions).toEqual(["nak:30000"]);
  await settleCapturedDelivery(
    { ...message, deliveryCount: CAPTURE_BRIDGE_MAX_DELIVER },
    decision,
    state,
  );
  expect(actions).toEqual([
    "nak:30000",
    "capture-bridge:fixture/post@revision=retries-exhausted:submission-failed",
    "ack",
  ]);
});

it("does not acknowledge if recording exhaustion fails", async () => {
  let acknowledged = false;
  await expect(
    settleCapturedDelivery(
      {
        deliveryCount: CAPTURE_BRIDGE_MAX_DELIVER,
        ack: async () => {
          acknowledged = true;
        },
        nak: () => undefined,
        term: () => undefined,
      },
      decision,
      {
        recordPermanentFailure: () => {
          throw new Error("state unavailable");
        },
      },
    ),
  ).rejects.toThrow("state unavailable");
  expect(acknowledged).toBe(false);
});
