import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  inspectOperation,
  isOperationKey,
  operationExitCode,
  renderOperation,
} from "../../src/diagnostics/operation-detail.js";
import { stateProbeFor } from "../../src/diagnostics/runtime-status.js";

const NOW = 1_760_000_000_000;
/** The worker entry runs from source under the test runner. */
const workerOptions = {
  workerUrl: new URL("../../src/diagnostics/state-probe-worker.ts", import.meta.url),
  execArgv: ["--import", "tsx"],
};
const artifact = {
  repository: "synthetic-archive",
  commit: "0123456789abcdef0123456789abcdef01234567",
  path: "records/example.json",
  hash: `sha256:${"ab".repeat(32)}`,
};

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryStore(): { path: string; store: OperationStore } {
  const dir = mkdtempSync(join(tmpdir(), "steele-operation-"));
  directories.push(dir);
  const path = join(dir, "operations.db");
  return { path, store: new OperationStore({ path, now: () => NOW }) };
}

const claimOf = (result: ReturnType<OperationStore["claim"]>) => {
  if (result.kind !== "claimed") throw new Error(`unexpected claim result ${result.kind}`);
  return result.claim;
};

describe("inspectOperation", () => {
  it("shows a completed operation with its logical artifact and event counts", async () => {
    const { path, store } = temporaryStore();
    const claim = claimOf(store.claim("op-done", "owner-sentinel", 60_000));
    store.complete(claim, { artifact }, [
      { eventId: "event-1", subject: "synthetic", payload: '{"secret":"payload-sentinel"}' },
    ]);
    store.close();

    const report = await inspectOperation(stateProbeFor(path, workerOptions), "op-done", {
      now: () => new Date(NOW),
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "found",
      operation: {
        key: "op-done",
        status: "completed",
        attempts: 1,
        maxAttempts: 5,
        exhausted: false,
        artifact: { kind: "reference", ...artifact },
        pendingEvents: { pending: 1, sent: 0 },
      },
    });
    expect(operationExitCode(report)).toBe(0);

    const json = JSON.stringify(report);
    const text = renderOperation(report);
    for (const output of [json, text]) {
      expect(output).not.toContain("owner-sentinel");
      expect(output).not.toContain("payload-sentinel");
      expect(output).not.toContain("/records/");
    }
    expect(text).toContain("artifact: synthetic-archive 0123456789ab:records/example.json");
  });

  it("reports a claimed operation as busy without exposing the owner", async () => {
    const { path, store } = temporaryStore();
    store.claim("op-busy", "owner-sentinel", 60_000);
    store.close();

    const report = await inspectOperation(stateProbeFor(path, workerOptions), "op-busy");
    expect(report).toMatchObject({
      status: "found",
      operation: {
        status: "claimed",
        exhausted: false,
        leaseExpiresAt: new Date(NOW + 60_000).toISOString(),
        pendingEvents: { pending: 0, sent: 0 },
      },
    });
    expect(JSON.stringify(report)).not.toContain("owner-sentinel");
    expect(operationExitCode(report)).toBe(0);
  });

  it("reports a failed operation with its sanitized code and exits 0", async () => {
    const { path, store } = temporaryStore();
    const claim = claimOf(store.claim("op-failed", "owner", 60_000));
    store.fail(claim, "synthetic-error", false);
    store.close();

    const report = await inspectOperation(stateProbeFor(path, workerOptions), "op-failed");
    expect(report).toMatchObject({
      status: "found",
      operation: { status: "failed", errorCode: "synthetic-error" },
    });
    expect(operationExitCode(report)).toBe(0);
    expect(renderOperation(report)).toContain("error code: synthetic-error");
  });

  it("reports an unknown key as not-found, never completed", async () => {
    const { path, store } = temporaryStore();
    store.close();
    const report = await inspectOperation(stateProbeFor(path, workerOptions), "no-such-key");
    expect(report).toEqual({
      schemaVersion: 1,
      observedAt: expect.any(String),
      status: "not-found",
    });
    expect(operationExitCode(report)).toBe(1);
    expect(renderOperation(report)).toContain("not-found");
  });

  it("reports missing state storage as unavailable without creating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steele-operation-"));
    directories.push(dir);
    const path = join(dir, "absent.db");
    const report = await inspectOperation(stateProbeFor(path, workerOptions), "op-missing");
    expect(report.status).toBe("unavailable");
    expect(operationExitCode(report)).toBe(1);
  });

  it("reports unavailable when no state controller is configured", async () => {
    const report = await inspectOperation(undefined, "op-any");
    expect(report.status).toBe("unavailable");
    expect(operationExitCode(report)).toBe(1);
  });

  it("reports unavailable when the synchronous probe overruns its deadline", async () => {
    const report = await inspectOperation(
      {
        readOperation: async () => {
          const end = Date.now() + 60;
          while (Date.now() < end) {
            // deliberate synchronous delay
          }
          return null;
        },
      },
      "op-any",
      { timeoutMs: 10 },
    );
    expect(report.status).toBe("unavailable");
  });

  it("accepts only keys the state controller can address", () => {
    expect(isOperationKey("op-1")).toBe(true);
    expect(isOperationKey("")).toBe(false);
    expect(isOperationKey("x".repeat(513))).toBe(false);
  });
});
