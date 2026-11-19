import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  OperationStore,
  type OperationStatusCount,
} from "../../src/controllers/operation-store.js";
import {
  collectRuntimeStatus,
  renderRuntimeStatus,
  runtimeStatusExitCode,
  elasticsearchProbe,
  natsProbe,
  stateProbeFor,
  type HealthProbe,
} from "../../src/diagnostics/runtime-status.js";

const NOW = 1_760_000_000_000;
const healthy: HealthProbe = { check: async () => undefined };
const failing: HealthProbe = {
  check: async () => {
    throw new Error("unreachable");
  },
};

/** The worker entry runs from source under the test runner. */
const workerOptions = {
  workerUrl: new URL("../../src/diagnostics/state-probe-worker.ts", import.meta.url),
  execArgv: ["--import", "tsx"],
};

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("collectRuntimeStatus", () => {
  it("reports a missing dependency as not-configured without failing the others", async () => {
    const report = await collectRuntimeStatus({ nats: healthy }, { now: () => new Date(NOW) });
    expect(report).toEqual({
      schemaVersion: 1,
      observedAt: new Date(NOW).toISOString(),
      checks: [
        { name: "state", status: "not-configured" },
        { name: "nats", status: "healthy" },
        { name: "elasticsearch", status: "not-configured" },
      ],
    });
    expect(runtimeStatusExitCode(report)).toBe(0);
  });

  it("keeps reachable checks when one dependency is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steele-status-"));
    directories.push(dir);
    const path = join(dir, "operations.db");
    const store = new OperationStore({ path, now: () => NOW });
    store.claim("op-claimed", "worker", 60_000);
    const failed = store.claim("op-failed", "worker", 60_000);
    if (failed.kind !== "claimed") throw new Error("unexpected claim");
    store.fail(failed.claim, "synthetic-error", false);
    store.close();

    const report = await collectRuntimeStatus(
      {
        state: stateProbeFor(path, workerOptions),
        nats: failing,
        elasticsearch: healthy,
      },
      { now: () => new Date(NOW) },
    );
    expect(report.checks).toEqual([
      {
        name: "state",
        status: "healthy",
        counts: [
          { status: "claimed", count: 1 },
          { status: "failed", count: 1 },
        ],
      },
      { name: "nats", status: "unavailable" },
      { name: "elasticsearch", status: "healthy" },
    ]);
    expect(runtimeStatusExitCode(report)).toBe(1);
  });

  it("aborts a probe that never settles and reports it unavailable", async () => {
    let aborted = false;
    const report = await collectRuntimeStatus(
      {
        nats: {
          check: (signal) =>
            new Promise<void>((_, reject) => {
              signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("aborted"));
              });
            }),
        },
        elasticsearch: healthy,
      },
      { timeoutMs: 10 },
    );
    expect(report.checks[1]).toEqual({ name: "nats", status: "unavailable" });
    expect(report.checks[2]).toEqual({ name: "elasticsearch", status: "healthy" });
    expect(aborted).toBe(true);
    expect(runtimeStatusExitCode(report)).toBe(1);
  });

  it("reports unavailable when synchronous state work exceeds the deadline", async () => {
    // A probe that cannot be interrupted by the timer: it must still not be
    // reported healthy after overrunning the bound.
    const report = await collectRuntimeStatus(
      {
        state: {
          readCounts: async () => {
            const end = Date.now() + 60;
            while (Date.now() < end) {
              // deliberate synchronous delay
            }
            return [{ status: "completed", count: 1 }];
          },
        },
      },
      { timeoutMs: 10 },
    );
    expect(report.checks[0]).toEqual({ name: "state", status: "unavailable" });
    expect(runtimeStatusExitCode(report)).toBe(1);
  });

  it("reports missing state storage as unavailable and creates nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steele-status-"));
    directories.push(dir);
    const path = join(dir, "absent.db");
    const report = await collectRuntimeStatus({ state: stateProbeFor(path, workerOptions) });
    expect(report.checks[0]).toEqual({ name: "state", status: "unavailable" });
    expect(runtimeStatusExitCode(report)).toBe(1);
  });

  it("terminates an unresponsive state inspection at the deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steele-status-"));
    directories.push(dir);
    const path = join(dir, "operations.db");
    const store = new OperationStore({ path, now: () => NOW });
    store.claim("op-claimed", "worker", 60_000);
    store.close();

    // A deadline shorter than a worker can start and answer forces the abort
    // path; the check must resolve, not hang.
    const report = await collectRuntimeStatus(
      { state: stateProbeFor(path, workerOptions) },
      { timeoutMs: 1 },
    );
    expect(report.checks[0]).toEqual({ name: "state", status: "unavailable" });
  });

  it("forwards the deadline through the controller probe wrappers", async () => {
    let natsSignal: AbortSignal | undefined;
    let searchSignal: AbortSignal | undefined;
    let searchClosed = false;
    const hanging = (record: (signal: AbortSignal | undefined) => void) => ({
      check: async (signal?: AbortSignal) => {
        record(signal);
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
      close: async () => undefined,
    });
    const searchController = {
      check: async (signal?: AbortSignal) => {
        searchSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
      close: async () => {
        searchClosed = true;
      },
    };
    const report = await collectRuntimeStatus(
      {
        nats: natsProbe(
          { url: "nats://unused.invalid" },
          hanging((s) => (natsSignal = s)),
        ),
        elasticsearch: elasticsearchProbe({ url: "http://unused.invalid" }, searchController),
      },
      { timeoutMs: 20 },
    );
    expect(report.checks[1]).toEqual({ name: "nats", status: "unavailable" });
    expect(report.checks[2]).toEqual({ name: "elasticsearch", status: "unavailable" });
    expect(natsSignal?.aborted).toBe(true);
    expect(searchSignal?.aborted).toBe(true);
    expect(searchClosed).toBe(true);
  });

  it("never renders a failing dependency's error text, origin or credential", async () => {
    const sentinel = "https://user:sentinel-password@internal-sentinel-host:9200 sentinel-token";
    const report = await collectRuntimeStatus({
      nats: {
        check: async () => {
          throw new Error(sentinel);
        },
      },
      elasticsearch: {
        check: async () => {
          throw new Error(sentinel);
        },
      },
    });
    const json = JSON.stringify(report);
    const text = renderRuntimeStatus(report);
    for (const output of [json, text]) {
      for (const value of [
        "sentinel-password",
        "internal-sentinel-host",
        "sentinel-token",
        "unreachable",
        sentinel,
      ]) {
        expect(output).not.toContain(value);
      }
    }
    expect(text).toContain("nats: unavailable");
    expect(text).toContain("elasticsearch: unavailable");
  });

  it("renders status counts in the human report", async () => {
    const counts: OperationStatusCount[] = [{ status: "completed", count: 3 }];
    const report = await collectRuntimeStatus(
      { state: { readCounts: async () => counts } },
      { now: () => new Date(NOW) },
    );
    const text = renderRuntimeStatus(report);
    expect(text).toContain("state: healthy (completed 3)");
    expect(text).toContain("nats: not-configured");
  });
});
