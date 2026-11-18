import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  OperationStore,
  OperationStoreError,
  SCHEMA_VERSION,
} from "../../src/controllers/operation-store.js";

let dir: string;
let path: string;
let clock: number;
const stores: OperationStore[] = [];
const open = (busyTimeoutMs = 2_000) => {
  const store = new OperationStore({ path, busyTimeoutMs, now: () => clock });
  stores.push(store);
  return store;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-ops-"));
  path = join(dir, "state.sqlite");
  clock = 1_000_000;
});
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await rm(dir, { recursive: true, force: true });
});

const artifact = {
  repository: "archive",
  commit: "a".repeat(40),
  path: "p.txt",
  sha256: "b".repeat(64),
};
const event = (n: number) => ({
  eventId: `evt-${n}`,
  subject: "steele.v1.content.extracted",
  payload: `{"n":${n}}`,
});

describe("OperationStore", () => {
  it("creates a versioned schema and rejects a newer one", () => {
    open().close();
    const raw = new DatabaseSync(path);
    expect(
      (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => open()).toThrow("unsupported-schema");
  });

  it("requires an absolute path and bounded busy timeout", () => {
    expect(() => new OperationStore({ path: "relative.sqlite" })).toThrow(OperationStoreError);
    expect(() => new OperationStore({ path, busyTimeoutMs: 600_000 })).toThrow("invalid-config");
  });

  it("gives a live claim to one owner only", () => {
    const a = open();
    const b = open();
    expect(a.claim("op-1", "worker-a", 1_000)).toMatchObject({ kind: "claimed", attempt: 1 });
    expect(b.claim("op-1", "worker-b", 1_000)).toEqual({
      kind: "busy",
      leaseExpiresAt: clock + 1_000,
    });
  });

  it("lets another owner claim after the lease expires", () => {
    const store = open();
    store.claim("op-1", "worker-a", 1_000);
    clock += 1_001;
    expect(store.claim("op-1", "worker-b", 1_000)).toMatchObject({ kind: "claimed", attempt: 2 });
    expect(() => store.complete("op-1", "worker-a", artifact, [])).toThrow("not-owner");
  });

  it("renews only a lease the caller still holds", () => {
    const store = open();
    store.claim("op-1", "worker-a", 1_000);
    expect(store.renew("op-1", "worker-a", 5_000)).toBe(clock + 5_000);
    expect(() => store.renew("op-1", "worker-b", 5_000)).toThrow("not-owner");
  });

  it("records completion and pending events atomically and reuses the result", () => {
    const store = open();
    store.claim("op-1", "worker-a", 1_000);
    store.complete("op-1", "worker-a", artifact, [event(1), event(2)]);
    expect(store.claim("op-1", "worker-b", 1_000)).toEqual({ kind: "completed", artifact });
    expect(store.duePendingEvents().map((e) => e.eventId)).toEqual(["evt-1", "evt-2"]);
  });

  it("treats a duplicate completion as a no-op", () => {
    const store = open();
    store.claim("op-1", "worker-a", 1_000);
    store.complete("op-1", "worker-a", artifact, [event(1)]);
    expect(store.complete("op-1", "worker-a", { other: true }, [event(1), event(9)])).toEqual(
      artifact,
    );
    expect(store.duePendingEvents().map((e) => e.eventId)).toEqual(["evt-1"]);
  });

  it("rolls back completion when an event record is invalid", () => {
    const store = open();
    store.claim("op-1", "worker-a", 1_000);
    expect(() =>
      store.complete("op-1", "worker-a", artifact, [
        event(1),
        { eventId: "", subject: "x", payload: "" },
      ]),
    ).toThrow("invalid-input");
    expect(store.duePendingEvents()).toEqual([]);
    expect(store.claim("op-1", "worker-a", 1_000).kind).toBe("busy");
  });

  it("retries pending events until marked sent, keeping the same event ID", () => {
    const store = open();
    store.claim("op-1", "worker-a", 1_000);
    store.complete("op-1", "worker-a", artifact, [event(1)]);
    store.markEventRetry("evt-1", 500);
    expect(store.duePendingEvents()).toEqual([]);
    clock += 500;
    expect(store.duePendingEvents()).toMatchObject([{ eventId: "evt-1", attempts: 1 }]);
    store.markEventSent("evt-1");
    store.markEventSent("evt-1");
    expect(store.duePendingEvents()).toEqual([]);
  });

  it("survives a restart with state intact", () => {
    const first = open();
    first.claim("op-1", "worker-a", 1_000);
    first.complete("op-1", "worker-a", artifact, [event(1)]);
    first.claim("op-2", "worker-a", 1_000);
    first.close();
    const second = open();
    expect(second.claim("op-1", "x", 1_000).kind).toBe("completed");
    expect(second.claim("op-2", "x", 1_000).kind).toBe("busy");
    expect(second.duePendingEvents()).toHaveLength(1);
  });

  it("bounds attempts and distinguishes permanent failures", () => {
    const store = open();
    expect(store.claim("op-1", "w", 1_000, 2).kind).toBe("claimed");
    store.fail("op-1", "w", "timeout", true);
    expect(store.claim("op-1", "w", 1_000, 2)).toMatchObject({ kind: "claimed", attempt: 2 });
    store.fail("op-1", "w", "timeout", true);
    expect(store.claim("op-1", "w", 1_000, 2)).toEqual({ kind: "exhausted", errorCode: "timeout" });

    store.claim("op-2", "w", 1_000);
    store.fail("op-2", "w", "malformed", false);
    expect(store.claim("op-2", "w", 1_000)).toEqual({ kind: "exhausted", errorCode: "malformed" });
  });

  it("rejects invalid claim input", () => {
    const store = open();
    expect(() => store.claim("", "w", 1_000)).toThrow("invalid-input");
    expect(() => store.claim("op", "w", 0)).toThrow("invalid-input");
  });
});

describe("concurrent processes", () => {
  it("grants exactly one claim across separate processes", async () => {
    open().close(); // create the schema first
    const worker = new URL("./fixtures/claim-worker.ts", import.meta.url).pathname;
    const runs = Array.from(
      { length: 6 },
      (_, i) =>
        new Promise<string>((resolve, reject) => {
          const child = fork(worker, [path, `worker-${i}`], {
            execArgv: ["--import", "tsx"],
            stdio: ["ignore", "ignore", "inherit", "ipc"],
          });
          child.on("message", (m) => resolve(String(m)));
          child.on("error", reject);
          child.on("exit", (code) => code !== 0 && reject(new Error(`exit ${code}`)));
        }),
    );
    const results = await Promise.all(runs);
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "busy")).toHaveLength(5);
  }, 30_000);
});
