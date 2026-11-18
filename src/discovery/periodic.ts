import { z } from "zod";
import type { DiscoveryRunSummary } from "./run.js";

/**
 * Periodic live discovery: run once immediately, then repeatedly with a
 * fixed delay measured from the end of each run, so a slow run never
 * overlaps the next. Failures back off exponentially up to a bound. Stopping
 * cancels the in-flight run and waits a bounded time for it to finish.
 *
 * Single-instance assumption: one runner per deployment. Running several
 * would discover the same posts more than once; that is tolerated because
 * downstream collection deduplicates by content key, but it is wasteful.
 *
 * No timers library, cron, database or protocol logic: the run function and
 * the delay are injected.
 */

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const ConfigSchema = z.object({
  /** Delay after each completed run. Bounded: 1 second to 24 hours. */
  intervalMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1000),
  /** Upper bound on the delay after repeated failures. */
  maxBackoffMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1000),
  /** Maximum wait for an in-flight run on stop. */
  shutdownTimeoutMs: z
    .number()
    .int()
    .min(0)
    .max(10 * 60 * 1000),
});

export type RunnerState = "idle" | "running" | "waiting" | "stopping" | "stopped";

/** Sanitised status: counts, states and outcome names only. */
export interface RunnerStatus {
  state: RunnerState;
  runs: number;
  consecutiveFailures: number;
  lastOutcome?: DiscoveryRunSummary["status"] | "error";
  lastPublished?: number;
  nextDelayMs?: number;
}

export interface PeriodicRunnerOptions {
  /** One discovery pass; must honour the signal. */
  run: (signal: AbortSignal) => Promise<DiscoveryRunSummary>;
  intervalMs?: number;
  maxBackoffMs?: number;
  shutdownTimeoutMs?: number;
  /** Injectable delay that rejects when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onStatus?: (status: RunnerStatus) => void;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export class PeriodicDiscoveryRunner {
  private readonly config: z.infer<typeof ConfigSchema>;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly abort = new AbortController();
  private loop?: Promise<void>;
  private status: RunnerStatus = { state: "idle", runs: 0, consecutiveFailures: 0 };

  constructor(private readonly options: PeriodicRunnerOptions) {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.config = ConfigSchema.parse({
      intervalMs,
      maxBackoffMs: options.maxBackoffMs ?? Math.max(intervalMs, 60 * 60 * 1000),
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 30_000,
    });
    if (this.config.maxBackoffMs < this.config.intervalMs) {
      throw new RangeError("maxBackoffMs must not be less than intervalMs");
    }
    this.sleep = options.sleep ?? defaultSleep;
  }

  getStatus(): RunnerStatus {
    return { ...this.status };
  }

  private update(patch: Partial<RunnerStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.onStatus?.(this.getStatus());
  }

  /** Delay before the next run: the interval, doubled per consecutive failure, bounded. */
  nextDelay(consecutiveFailures: number): number {
    if (consecutiveFailures === 0) return this.config.intervalMs;
    const factor = 2 ** Math.min(consecutiveFailures, 30);
    return Math.min(this.config.maxBackoffMs, this.config.intervalMs * factor);
  }

  /** Start the loop. Idempotent; resolves when the runner has stopped. */
  start(): Promise<void> {
    this.loop ??= this.runLoop();
    return this.loop;
  }

  private async runLoop(): Promise<void> {
    const { signal } = this.abort;
    while (!signal.aborted) {
      this.update({ state: "running" });
      let failed: boolean;
      try {
        const summary = await this.options.run(signal);
        failed = summary.status === "failed";
        this.update({
          runs: this.status.runs + 1,
          lastOutcome: summary.status,
          lastPublished: summary.published,
        });
      } catch {
        failed = true;
        this.update({ runs: this.status.runs + 1, lastOutcome: "error", lastPublished: undefined });
      }
      if (signal.aborted) break;
      const consecutiveFailures = failed ? this.status.consecutiveFailures + 1 : 0;
      const nextDelayMs = this.nextDelay(consecutiveFailures);
      this.update({ state: "waiting", consecutiveFailures, nextDelayMs });
      try {
        await this.sleep(nextDelayMs, signal);
      } catch {
        break;
      }
    }
    this.update({ state: "stopped", nextDelayMs: undefined });
  }

  /**
   * Stop scheduling, cancel the in-flight run and wait for it up to the
   * shutdown timeout. Returns false if the run did not finish in time.
   */
  async stop(): Promise<boolean> {
    if (this.status.state !== "stopped") this.update({ state: "stopping" });
    this.abort.abort();
    if (!this.loop) {
      this.update({ state: "stopped" });
      return true;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.config.shutdownTimeoutMs);
    });
    const finished = await Promise.race([this.loop.then(() => true as const), timeout]);
    clearTimeout(timer);
    return finished;
  }
}
