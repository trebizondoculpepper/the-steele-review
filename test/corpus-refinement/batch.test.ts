import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  BatchError,
  batchPath,
  batchRecords,
  readBatch,
  saveBatch,
  stepInput,
  toBatch,
} from "../../src/corpus-refinement/batch.js";

// A temporary store and synthetic records only (#856).
let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "corpus-batch-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "corpus-test" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const input = (runId: string, ids: string[]) => ({
  runId,
  mode: "archive" as const,
  claims: ids.map((id) => ({ id, statement: `Statement ${id}.`, covered: false })),
  deferred: ["later"],
});

describe("pinned batch input (#856)", () => {
  it("saves one versioned batch, reads it back validated, in record order", async () => {
    const { batch, parameters } = toBatch(input("run-a", ["c2", "c1", "c3"]));
    const ref = await saveBatch(artifacts, batch);
    expect(ref.path).toBe(batchPath("run-a"));
    const read = await readBatch(artifacts, ref, "run-a");
    expect(read).toMatchObject({ schemaVersion: 1, kind: "corpus-refinement-batch" });
    expect([...batchRecords(read)].map((r) => r.id)).toEqual(["c2", "c1", "c3"]);
    // Parameters travel apart from the data, and rebuild the step input.
    expect(parameters).toEqual({ runId: "run-a", mode: "archive" });
    expect(stepInput(read, parameters)).toEqual(input("run-a", ["c2", "c1", "c3"]));
  });

  it("reopens the same saved batch on replay, and refuses different records", async () => {
    const first = await saveBatch(artifacts, toBatch(input("run-b", ["c1"])).batch);
    const replay = await saveBatch(artifacts, toBatch(input("run-b", ["c1"])).batch);
    expect(replay).toEqual(first);
    await expect(saveBatch(artifacts, toBatch(input("run-b", ["c9"])).batch)).rejects.toThrow(
      /saved-with-different-records/,
    );
  });

  it("handles an empty batch", async () => {
    const empty = { ...toBatch(input("run-c", [])).batch, deferred: [] };
    const read = await readBatch(artifacts, await saveBatch(artifacts, empty), "run-c");
    expect([...batchRecords(read)]).toEqual([]);
  });

  it("rejects a malformed, mismatched or duplicated batch on read", async () => {
    const reason = async (content: string, runId = "run-d") => {
      const ref = await artifacts.write(`corpus-refinement/x-${Math.random()}/batch.json`, content);
      try {
        await readBatch(artifacts, ref, runId);
        return "accepted";
      } catch (error) {
        return error instanceof BatchError ? error.reason : "other";
      }
    };
    const valid = toBatch(input("run-d", ["c1"])).batch;
    expect(await reason("{not json")).toBe("malformed-json");
    expect(await reason(JSON.stringify({ ...valid, schemaVersion: 2 }))).toBe(
      "schema:schemaVersion",
    );
    expect(await reason(JSON.stringify(valid), "run-other")).toBe("run:run-d");
    expect(
      await reason(JSON.stringify({ ...valid, records: [...valid.records, ...valid.records] })),
    ).toBe("schema:records");
  });

  it("keeps a storage failure retryable instead of calling it malformed", async () => {
    const ref = await saveBatch(artifacts, toBatch(input("run-e", ["c1"])).batch);
    const failing = { read: async () => Promise.reject(new Error("synthetic storage outage")) };
    await expect(readBatch(failing, ref, "run-e")).rejects.toThrow("synthetic storage outage");
    await expect(readBatch(failing, ref, "run-e")).rejects.not.toBeInstanceOf(BatchError);
  });
});
