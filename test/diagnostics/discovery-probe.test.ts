import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { probeDiscovery } from "../../src/diagnostics/discovery-probe.js";
import { writeDiscoveryStatus } from "../../src/discovery/status.js";

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-discovery-probe-"));
  path = join(dir, "discovery.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-22T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const probe = () => probeDiscovery({ statusPath: path, pollIntervalMs: 300_000, now: () => NOW });

describe("discovery poller probe (#327)", () => {
  it("is ready after a recent poll, including an unchanged feed", async () => {
    await writeDiscoveryStatus(path, {
      at: minutesAgo(1),
      lastPollAt: minutesAgo(4),
      state: "waiting",
      runs: 12,
      consecutiveFailures: 0,
      lastOutcome: "no-change",
      lastPublished: 0,
    });
    expect(await probe()).toEqual({
      schemaVersion: 1,
      role: "discovery-poller",
      live: true,
      ready: true,
      checks: { status: "healthy", poll: "healthy", failures: "healthy" },
      details: { runs: 12, consecutiveFailures: 0, lastPollAt: minutesAgo(4) },
    });
  });

  it("reports a stalled loop, then recovers when a poll completes", async () => {
    // Lifecycle updates refresh `at`, but the last completed poll is old.
    await writeDiscoveryStatus(path, {
      at: minutesAgo(1),
      lastPollAt: minutesAgo(40),
      state: "waiting",
      runs: 3,
      consecutiveFailures: 0,
    });
    const stalled = await probe();
    expect(stalled.ready).toBe(false);
    expect(stalled.checks).toEqual({ status: "healthy", poll: "unavailable", failures: "healthy" });
    await writeDiscoveryStatus(path, {
      at: minutesAgo(0),
      lastPollAt: minutesAgo(0),
      state: "waiting",
      runs: 4,
      consecutiveFailures: 0,
    });
    expect((await probe()).ready).toBe(true);
  });

  it("reports repeated failed polls separately from staleness", async () => {
    await writeDiscoveryStatus(path, {
      at: minutesAgo(0),
      lastPollAt: minutesAgo(3),
      state: "waiting",
      runs: 9,
      consecutiveFailures: 3,
      lastOutcome: "failed",
    });
    expect((await probe()).checks).toEqual({
      status: "healthy",
      poll: "healthy",
      failures: "unavailable",
    });
  });

  it("reports a missing or malformed status file and leaks no path", async () => {
    const missing = await probe();
    expect(missing.checks).toEqual({
      status: "unavailable",
      poll: "unavailable",
      failures: "unavailable",
    });
    expect(JSON.stringify(missing)).not.toContain(dir);
    await writeFile(path, "{ not json");
    expect((await probe()).checks.status).toBe("unavailable");
    // No poll yet after start-up is not ready.
    await writeDiscoveryStatus(path, { state: "running", runs: 0, consecutiveFailures: 0 });
    expect((await probe()).checks).toMatchObject({ status: "healthy", poll: "unavailable" });
  });

  it("reports an unconfigured status path as not-configured", async () => {
    expect((await probeDiscovery({})).checks).toEqual({
      status: "not-configured",
      poll: "not-configured",
      failures: "not-configured",
    });
  });
});
