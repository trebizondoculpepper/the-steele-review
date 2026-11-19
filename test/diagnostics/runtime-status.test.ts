import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  collectRuntimeStatus,
  renderRuntimeStatus,
  runtimeStatusExitCode,
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

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("collectRuntimeStatus", () => {
  it("reports a missing dependency as not-configured without failing the others", async () => {
    const report = await collectRuntimeStatus(
      { nats: healthy },
      { now: () => new Date(NOW) },
    );
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
        state: stateProbeFor(path),
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

  it("bounds a probe that never settles and reports it unavailable", async () => {
    const report = await collectRuntimeStatus(
      { nats: { check: () => new Promise<void>(() => undefined) }, elasticsearch: healthy },
      { timeoutMs: 10 },
    );
    expect(report.checks[1]).toEqual({ name: "nats", status: "unavailable" });
    expect(report.checks[2]).toEqual({ name: "elasticsearch", status: "healthy" });
    expect(runtimeStatusExitCode(report)).toBe(1);
  });

  it("reports missing state storage as unavailable and creates nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steele-status-"));
    directories.push(dir);
    const path = join(dir, "absent.db");
    const report = await collectRuntimeStatus({ state: stateProbeFor(path) });
    expect(report.checks[0]).toEqual({ name: "state", status: "unavailable" });
    expect(runtimeStatusExitCode(report)).toBe(1);
  });

  it("never renders a failing dependency's error text, endpoint or credential", async () => {
    const sentinel =
      "https://user:sentinel-password@internal-sentinel-host:9200 sentinel-token";
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
    const report = await collectRuntimeStatus(
      {
        state: {
          statusCounts: () => [{ status: "completed", count: 3 }],
        },
      },
      { now: () => new Date(NOW) },
    );
    const text = renderRuntimeStatus(report);
    expect(text).toContain("state: healthy (completed 3)");
    expect(text).toContain("nats: not-configured");
  });
});
