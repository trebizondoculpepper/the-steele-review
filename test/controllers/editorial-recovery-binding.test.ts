import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";
const ref = (path: string) => ({
  repository: "content",
  commit: "a".repeat(40),
  path,
  hash: `sha256:${"b".repeat(64)}`,
});
it("reserves a denied task once and reconnects its exact intent across controller instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recovery-slot-")),
    path = join(dir, "state.sqlite"),
    a = new OperationStore({ path }),
    b = new OperationStore({ path });
  const input = {
    publicationId: "pub",
    postId: "p1",
    requestId: "recover-one",
    generation: 1,
    capture: ref("editorial-attempts/denied/manifest.json"),
    taskDigest: "c".repeat(64),
    inputHash: "d".repeat(64),
    intent: ref("intent.json"),
    parentSummary: ref("parent.json"),
  };
  try {
    const first = a.recordEditorialRecovery(input);
    expect(b.recordEditorialRecovery(input)).toEqual(first);
    expect(b.editorialRecoveryAttempt("pub", "p1", "recover-one")).toEqual(first);
    expect(() =>
      b.recordEditorialRecovery({ ...input, requestId: "competing", generation: 2 }),
    ).toThrow("invalid-input");
    expect(b.editorialRecoveryAttempt("pub", "p1", "competing")).toBeUndefined();
    expect(() => b.recordEditorialRecovery({ ...input, generation: 2 })).toThrow("invalid-input");
    expect(() => b.recordEditorialRecovery({ ...input, inputHash: "e".repeat(64) })).toThrow(
      "invalid-input",
    );
    const distinct = b.recordEditorialRecovery({
      ...input,
      requestId: "later-denial",
      generation: 2,
      capture: ref("editorial-attempts/new-denial/manifest.json"),
    });
    expect(distinct.workflowKey).not.toBe(first.workflowKey);
  } finally {
    a.close();
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});
