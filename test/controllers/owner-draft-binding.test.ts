import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";

describe("atomic owner draft intent and version ownership", () => {
  it("persists one owner and reconnects without accepting competing intent", () => {
    const dir = mkdtempSync(join(tmpdir(), "owner-draft-state-")),
      path = join(dir, "state.sqlite");
    let ops = new OperationStore({ path });
    try {
      const input = {
        publicationId: "pub",
        postId: "post",
        requestId: "one",
        requestHash: "a".repeat(64),
        versionIdentity: "b".repeat(64),
      };
      const first = ops.recordOwnerDraftIntent(input);
      ops.close();
      ops = new OperationStore({ path });
      expect(ops.recordOwnerDraftIntent(input)).toEqual(first);
      expect(() => ops.recordOwnerDraftIntent({ ...input, requestId: "two" })).toThrow(
        "invalid-input",
      );
      expect(ops.ownerDraftIntent("pub", "post", "two")).toBeUndefined();
    } finally {
      ops.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not poison a second version when a request retries with changed inputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "owner-draft-state-")),
      ops = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      const input = {
        publicationId: "pub",
        postId: "post",
        requestId: "one",
        requestHash: "a".repeat(64),
        versionIdentity: "b".repeat(64),
      };
      ops.recordOwnerDraftIntent(input);
      expect(() =>
        ops.recordOwnerDraftIntent({
          ...input,
          requestHash: "d".repeat(64),
          versionIdentity: "c".repeat(64),
        }),
      ).toThrow("invalid-input");
      expect(
        ops.recordOwnerDraftIntent({
          ...input,
          requestId: "two",
          requestHash: "e".repeat(64),
          versionIdentity: "c".repeat(64),
        }).requestId,
      ).toBe("two");
      expect(ops.ownerDraftIntent("pub", "post", "one")?.versionIdentity).toBe("b".repeat(64));
    } finally {
      ops.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
