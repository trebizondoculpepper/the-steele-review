import { describe, expect, it } from "vite-plus/test";
import { PeriodicDiscoveryRunner, type RunnerStatus } from "../../src/discovery/periodic.js";
import type { DiscoveryRunSummary } from "../../src/discovery/run.js";

const summary = (status: DiscoveryRunSummary["status"], published = 1): DiscoveryRunSummary => ({
  status,
  correlationId: "run",
  reason: "live",
  discovered: published,
  published,
});

/** Controllable fake delay: records requested delays; tests release them. */
function fakeSleep() {
  const delays: number[] = [];
  const pending: Array<() => void> = [];
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      delays.push(ms);
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      pending.push(resolve);
    });
  const release = () => pending.shift()?.();
  return { sleep, delays, release };
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await tick();
  if (!check()) throw new Error("condition not reached");
}

describe("PeriodicDiscoveryRunner", () => {
  it("validates the interval bounds", () => {
    const run = async () => summary("complete");
    expect(() => new PeriodicDiscoveryRunner({ run, intervalMs: 0 })).toThrow();
    expect(() => new PeriodicDiscoveryRunner({ run, intervalMs: 500 })).toThrow();
    expect(() => new PeriodicDiscoveryRunner({ run, intervalMs: 2 * 86_400_000 })).toThrow();
    expect(
      () => new PeriodicDiscoveryRunner({ run, intervalMs: 60_000, maxBackoffMs: 1_000 }),
    ).toThrow(RangeError);
    expect(new PeriodicDiscoveryRunner({ run }).nextDelay(0)).toBe(300_000);
  });

  it("runs immediately, then after each completed run with the interval", async () => {
    const fake = fakeSleep();
    let runs = 0;
    const runner = new PeriodicDiscoveryRunner({
      run: async () => {
        runs++;
        return summary("complete");
      },
      intervalMs: 60_000,
      sleep: fake.sleep,
    });
    void runner.start();
    await until(() => runs === 1 && fake.delays.length === 1);
    expect(fake.delays).toEqual([60_000]);
    fake.release();
    await until(() => runs === 2);
    await runner.stop();
  });

  it("never overlaps a slow run with the next one", async () => {
    const fake = fakeSleep();
    let active = 0;
    let maxActive = 0;
    let finishRun: () => void = () => {};
    let runs = 0;
    const runner = new PeriodicDiscoveryRunner({
      run: async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => (finishRun = r));
        active--;
        return summary("complete");
      },
      intervalMs: 1_000,
      sleep: fake.sleep,
    });
    void runner.start();
    await until(() => runs === 1);
    // While the run is in progress no delay has been scheduled.
    expect(fake.delays).toEqual([]);
    finishRun();
    await until(() => fake.delays.length === 1);
    fake.release();
    await until(() => runs === 2);
    finishRun();
    await until(() => fake.delays.length === 2);
    expect(maxActive).toBe(1);
    await runner.stop();
  });

  it("backs off on failures up to the bound and resets on success", async () => {
    const fake = fakeSleep();
    const outcomes: Array<DiscoveryRunSummary["status"] | "throw"> = [
      "failed",
      "throw",
      "failed",
      "failed",
      "complete",
    ];
    const statuses: RunnerStatus[] = [];
    const runner = new PeriodicDiscoveryRunner({
      run: async () => {
        const next = outcomes.shift() ?? "complete";
        if (next === "throw") throw new Error("https://private.example secret");
        return summary(next);
      },
      intervalMs: 1_000,
      maxBackoffMs: 5_000,
      sleep: fake.sleep,
      onStatus: (s) => statuses.push(s),
    });
    void runner.start();
    for (let i = 0; i < 5; i++) {
      await until(() => fake.delays.length === i + 1);
      fake.release();
    }
    expect(fake.delays).toEqual([2_000, 4_000, 5_000, 5_000, 1_000]);
    expect(statuses.some((s) => s.lastOutcome === "error")).toBe(true);
    expect(JSON.stringify(statuses)).not.toContain("private");
    expect(runner.getStatus().consecutiveFailures).toBe(0);
    await runner.stop();
  });

  it("stops future runs and cancels the in-flight run on shutdown", async () => {
    let sawAbort = false;
    let runs = 0;
    const runner = new PeriodicDiscoveryRunner({
      run: (signal) =>
        new Promise((resolve) => {
          runs++;
          signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve(summary("cancelled", 0));
          });
        }),
      intervalMs: 1_000,
    });
    const loop = runner.start();
    await until(() => runs === 1);
    expect(await runner.stop()).toBe(true);
    await loop;
    expect(sawAbort).toBe(true);
    expect(runs).toBe(1);
    expect(runner.getStatus().state).toBe("stopped");
  });

  it("waits only a bounded time for a run that ignores cancellation", async () => {
    const runner = new PeriodicDiscoveryRunner({
      run: () => new Promise(() => {}),
      intervalMs: 1_000,
      shutdownTimeoutMs: 20,
    });
    void runner.start();
    await tick();
    expect(await runner.stop()).toBe(false);
  });

  it("stops while waiting between runs", async () => {
    const fake = fakeSleep();
    const runner = new PeriodicDiscoveryRunner({
      run: async () => summary("complete"),
      intervalMs: 1_000,
      sleep: fake.sleep,
    });
    const loop = runner.start();
    await until(() => fake.delays.length === 1);
    expect(await runner.stop()).toBe(true);
    await loop;
    expect(runner.getStatus()).toMatchObject({ state: "stopped", runs: 1 });
  });

  it("starts only one loop when start is called twice", async () => {
    const fake = fakeSleep();
    let runs = 0;
    const runner = new PeriodicDiscoveryRunner({
      run: async () => {
        runs++;
        return summary("complete");
      },
      intervalMs: 1_000,
      sleep: fake.sleep,
    });
    void runner.start();
    void runner.start();
    await until(() => fake.delays.length === 1);
    expect(runs).toBe(1);
    await runner.stop();
  });
});
