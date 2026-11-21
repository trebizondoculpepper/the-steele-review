import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { CatchUpCheckpointStore } from "../../src/collection/index-catchup.js";
import { systemStatusSource } from "../../src/dashboard/status-adapters.js";
import { writeDiscoveryStatus } from "../../src/discovery/status.js";

const NOW = new Date("2026-01-01T10:00:00.000Z");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "steele-status-"));
  dirs.push(dir);
  return dir;
};

const healthy = { check: async () => undefined };
const countProbe = {
  readCounts: async () => [
    { status: "completed" as const, count: 4 },
    { status: "failed" as const, count: 1 },
  ],
};

const checkpoint = (state?: { commit?: string }): CatchUpCheckpointStore => ({
  load: async () => state,
  save: async () => undefined,
});

const archive = (over: {
  paths?: string[];
  head?: string;
  changes?: number;
  fail?: boolean;
}) => ({
  list: async () =>
    over.fail
      ? Promise.reject(new Error("git failed"))
      : (over.paths ?? [
          "substack/pub/one/collected.json",
          "substack/pub/two/collected.json",
          "substack/pub/one/other.json",
        ]),
  changesSince: async () =>
    over.fail
      ? Promise.reject(new Error("git failed"))
      : {
          head: over.head ?? "bbb",
          full: false,
          changes: Array.from({ length: over.changes ?? 0 }, (_, n) => ({
            path: `substack/pub/x${n}/collected.json`,
            change: "upsert" as const,
          })),
        },
});

describe("systemStatusSource", () => {
  it("combines service checks, pipeline counts, archive and a current index", async () => {
    const source = systemStatusSource({
      runtime: { state: countProbe, nats: healthy, elasticsearch: healthy },
      archive: archive({ head: "aaa" }),
      checkpoint: checkpoint({ commit: "aaa" }),
      now: () => NOW,
    });
    const status = await source.read();
    expect(status.services).toEqual([
      { name: "state", state: "healthy" },
      { name: "nats", state: "healthy" },
      { name: "elasticsearch", state: "healthy" },
    ]);
    expect(status.operations).toEqual([
      { status: "completed", count: 4 },
      { status: "failed", count: 1 },
    ]);
    expect(status.archive).toEqual({ state: "ok", captured: 2, truncated: false });
    expect(status.indexCatchUp).toEqual({ state: "current" });
    expect(status.feedPoll).toEqual({ state: "not-configured" });
  });

  it("reports index lag as the number of pending changes", async () => {
    const source = systemStatusSource({
      runtime: {},
      archive: archive({ head: "ccc", changes: 3 }),
      checkpoint: checkpoint({ commit: "aaa" }),
      now: () => NOW,
    });
    expect((await source.read()).indexCatchUp).toEqual({ state: "behind", pendingChanges: 3 });
  });

  it("treats an index with no checkpoint as pending", async () => {
    const source = systemStatusSource({
      runtime: {},
      archive: archive({}),
      checkpoint: checkpoint(undefined),
      now: () => NOW,
    });
    expect((await source.read()).indexCatchUp).toEqual({ state: "pending" });
  });

  it("labels unconfigured sources instead of hiding them", async () => {
    const status = await systemStatusSource({ runtime: {}, now: () => NOW }).read();
    expect(status.archive).toEqual({ state: "not-configured" });
    expect(status.indexCatchUp).toEqual({ state: "not-configured" });
    expect(status.feedPoll).toEqual({ state: "not-configured" });
    expect(status.services.map((s) => s.state)).toEqual([
      "not-configured",
      "not-configured",
      "not-configured",
    ]);
  });

  it("reports an unavailable archive rather than failing the page", async () => {
    const source = systemStatusSource({
      runtime: {},
      archive: archive({ fail: true }),
      checkpoint: checkpoint({ commit: "aaa" }),
      now: () => NOW,
    });
    const status = await source.read();
    expect(status.archive).toEqual({ state: "unavailable" });
    expect(status.indexCatchUp).toEqual({ state: "unavailable" });
  });

  it("reports a stale feed poll from the runner status file", async () => {
    const dir = directory();
    const path = join(dir, "discovery.json");
    await writeDiscoveryStatus(path, {
      at: "2026-01-01T09:00:00.000Z",
      state: "waiting",
      runs: 4,
      consecutiveFailures: 0,
    });
    const source = systemStatusSource({ runtime: {}, discoveryStatusPath: path, now: () => NOW });
    expect((await source.read()).feedPoll).toEqual({
      state: "stale",
      at: "2026-01-01T09:00:00.000Z",
    });
  });

  it("reports a recent poll as current and a missing status file as unavailable", async () => {
    const dir = directory();
    const path = join(dir, "discovery.json");
    await writeDiscoveryStatus(path, {
      at: "2026-01-01T09:59:00.000Z",
      state: "waiting",
      runs: 1,
      consecutiveFailures: 0,
    });
    const recent = systemStatusSource({ runtime: {}, discoveryStatusPath: path, now: () => NOW });
    expect((await recent.read()).feedPoll.state).toBe("current");

    const missing = systemStatusSource({
      runtime: {},
      discoveryStatusPath: join(dir, "absent.json"),
      now: () => NOW,
    });
    expect((await missing.read()).feedPoll).toEqual({ state: "unavailable" });
  });
});
