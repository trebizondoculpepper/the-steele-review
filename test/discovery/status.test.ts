import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DISCOVERY_STATUS_SCHEMA_VERSION,
  readDiscoveryStatus,
  writeDiscoveryStatus,
} from "../../src/discovery/status.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "steele-discovery-status-"));
  dirs.push(dir);
  return dir;
};

describe("discovery status file", () => {
  it("round-trips a status and leaves no temporary file", async () => {
    const dir = directory();
    const path = join(dir, "status.json");
    await writeDiscoveryStatus(path, {
      at: "2026-01-01T00:00:00.000Z",
      state: "waiting",
      runs: 7,
      consecutiveFailures: 1,
      lastOutcome: "published",
      lastPublished: 2,
      nextDelayMs: 60_000,
    });
    expect(await readDiscoveryStatus(path)).toEqual({
      schemaVersion: DISCOVERY_STATUS_SCHEMA_VERSION,
      at: "2026-01-01T00:00:00.000Z",
      state: "waiting",
      runs: 7,
      consecutiveFailures: 1,
      lastOutcome: "published",
      lastPublished: 2,
      nextDelayMs: 60_000,
    });
    expect(readdirSync(dir)).toEqual(["status.json"]);
  });

  it("omits optional fields that were not supplied", async () => {
    const dir = directory();
    const path = join(dir, "status.json");
    await writeDiscoveryStatus(path, {
      at: "2026-01-01T00:00:00.000Z",
      state: "running",
      runs: 0,
      consecutiveFailures: 0,
    });
    const status = await readDiscoveryStatus(path);
    expect(status).not.toHaveProperty("lastOutcome");
    expect(status).not.toHaveProperty("lastPublished");
  });

  it("treats a missing or malformed file as absent", async () => {
    const dir = directory();
    expect(await readDiscoveryStatus(join(dir, "absent.json"))).toBeUndefined();

    const malformed = join(dir, "bad.json");
    writeFileSync(malformed, "{not json");
    expect(await readDiscoveryStatus(malformed)).toBeUndefined();

    const wrongShape = join(dir, "shape.json");
    writeFileSync(wrongShape, JSON.stringify({ schemaVersion: 1, state: "waiting" }));
    expect(await readDiscoveryStatus(wrongShape)).toBeUndefined();
  });
});
