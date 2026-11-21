import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { ARTICLE_APPROVED_SUBJECT } from "../../src/events/article-approved-event.js";
import { dispatchApprovedArticles } from "../../src/publishing/approval-dispatch.js";

let dir: string;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-approval-dispatch-"));
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const record = (eventId: string, subject = ARTICLE_APPROVED_SUBJECT) =>
  operations.reconcileCompleted(`approved:${eventId}`, { eventId }, [
    { eventId, subject, payload: JSON.stringify({ id: eventId }) },
  ]);

describe("approval outbox dispatch (#271)", () => {
  it("publishes due approvals by event ID, marks them sent, and leaves other subjects alone", async () => {
    record("approved-1");
    record("approved-2");
    record("other-1", "steele.v1.theme.occurred");
    const sent: { subject: string; msgId: string }[] = [];
    const out = await dispatchApprovedArticles({
      operations,
      publisher: { publish: async (subject, _d, o) => void sent.push({ subject, msgId: o.msgId }) },
    });
    expect(out).toEqual({ sent: 2, retrying: 0 });
    expect(sent.map((s) => s.msgId).sort()).toEqual(["approved-1", "approved-2"]);
    expect(operations.pendingEventStatus("approved-1")).toBe("sent");
    expect(operations.pendingEventStatus("other-1")).toBe("pending");
    // Nothing is due any more.
    expect(
      await dispatchApprovedArticles({ operations, publisher: { publish: async () => undefined } }),
    ).toEqual({ sent: 0, retrying: 0 });
  });

  it("keeps a failed publish pending with the same ID for a later retry", async () => {
    record("approved-1");
    const out = await dispatchApprovedArticles({
      operations,
      publisher: {
        publish: async () => {
          throw new Error("broker down");
        },
      },
      retryDelayMs: 1,
    });
    expect(out).toEqual({ sent: 0, retrying: 1 });
    expect(operations.pendingEventStatus("approved-1")).toBe("pending");
    await new Promise((r) => setTimeout(r, 10));
    const msgIds: string[] = [];
    await dispatchApprovedArticles({
      operations,
      publisher: { publish: async (_s, _d, o) => void msgIds.push(o.msgId) },
    });
    expect(msgIds).toEqual(["approved-1"]);
  });
});
