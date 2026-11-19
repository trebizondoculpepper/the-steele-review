import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { assertAllowedDestination } from "../controllers/substack/http.js";

/**
 * Temporary-media transcription for content without a usable supplied
 * transcript. Media is downloaded into a bounded private workspace, handed to
 * an injected provider, and deleted: immediately on failure, or by the caller
 * once the transcript is durably stored. Abandoned files from crashed runs
 * are removed by `sweepExpired()`, which is safe to run at startup.
 *
 * Audio is always tried before video. Size, duration, concurrency, timeout
 * and total workspace use are bounded, and download destinations are
 * allowlisted. Media is never returned, archived, indexed or published.
 *
 * The provider and its credentials are external configuration; no provider
 * is hard-coded. Machine transcripts are marked as such and never treated as
 * verified quotation. Timestamps appear only when the provider supplies them.
 */

export type MediaKind = "audio" | "video";

export interface MediaCandidate {
  kind: MediaKind;
  /** HTTPS URL of the media (audio or a resolved video file). */
  url: string;
  durationSeconds?: number;
}

export interface ProviderSegment {
  text: string;
  start?: number;
  end?: number;
}

export interface ProviderResult {
  segments: ProviderSegment[];
  language?: string;
  /** Provider-reported confidence in [0, 1], when available. */
  confidence?: number;
  /** True if the provider reports it transcribed the whole input. */
  complete?: boolean;
}

/** Injected speech-to-text provider. Receives a local file path, never a URL. */
export interface TranscriptionProvider {
  readonly name: string;
  readonly model: string;
  /** Maximum additional on-disk conversion/output scratch per job. */
  readonly maxScratchBytes?: number;
  transcribe(
    input: { path: string; kind: MediaKind; durationSeconds?: number },
    signal: AbortSignal,
  ): Promise<ProviderResult>;
}

export interface TranscriptCandidate {
  text: string;
  segments: ProviderSegment[];
  /** True only if every segment carries provider-supplied start and end times. */
  timestamped: boolean;
  language?: string;
  provider: string;
  model: string;
  mediaKind: MediaKind;
  /** The media candidate actually transcribed (source URL as given), for provenance. */
  mediaUrl: string;
  confidence?: number;
  complete: boolean;
  /** Always true: machine text, not verified quotation. */
  machineGenerated: true;
}

export interface TranscriptionJob {
  transcript: TranscriptCandidate;
  /** Delete the temporary media. Call after the transcript is durably stored. */
  cleanup: () => Promise<void>;
}

export type TranscriptionFailure =
  | "too-long"
  | "too-large"
  | "workspace-full"
  | "destination-refused"
  | "download-failed"
  | "provider-failed"
  | "empty-transcript"
  | "timeout"
  | "cancelled";

export class TranscriptionError extends Error {
  constructor(
    readonly reason: TranscriptionFailure,
    readonly retryable: boolean,
  ) {
    super(`transcription ${reason}`);
    this.name = "TranscriptionError";
  }
}

const Seconds = z.number().finite().nonnegative();
const ProviderResultSchema = z.object({
  segments: z
    .array(
      z
        .object({
          text: z.string().max(100_000),
          start: Seconds.optional(),
          end: Seconds.optional(),
        })
        .refine((s) => s.start === undefined || s.end === undefined || s.end >= s.start, {
          message: "segment ends before it starts",
        }),
    )
    .max(1_000_000),
  language: z.string().min(1).max(35).optional(),
  confidence: z.number().min(0).max(1).optional(),
  complete: z.boolean().optional(),
});

const ConfigSchema = z.object({
  workspaceDir: z.string().refine(isAbsolute, "workspaceDir must be absolute"),
  allowedHosts: z.array(z.string().min(1)).min(1),
  maxBytes: z.number().int().positive(),
  maxDurationSeconds: z.number().positive(),
  maxWorkspaceBytes: z.number().int().positive(),
  maxConcurrency: z.number().int().min(1).max(16),
  timeoutMs: z.number().int().positive(),
  retentionMs: z.number().int().positive(),
});

export interface TranscriptionAdapterConfig {
  provider: TranscriptionProvider;
  /** Private temporary directory on local disk (runtime configuration). */
  workspaceDir: string;
  /** Hosts media may be downloaded from. */
  allowedHosts: string[];
  maxBytes?: number;
  maxDurationSeconds?: number;
  maxWorkspaceBytes?: number;
  maxConcurrency?: number;
  /** Overall bound per job: download plus transcription. */
  timeoutMs?: number;
  /** Age after which unclaimed temporary media is deleted by sweepExpired. */
  retentionMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Deletes a job directory; injectable to test cleanup failures. */
  removeDirectory?: (path: string) => Promise<void>;
}

export class TranscriptionAdapter {
  private readonly config: z.infer<typeof ConfigSchema>;
  private readonly hosts: ReadonlySet<string>;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly removeDirectory: (path: string) => Promise<void>;
  private active = 0;
  private reservedBytes = 0;
  /** Job directories created by this instance; others are surviving media. */
  private readonly ownJobs = new Map<string, () => Promise<void>>();
  /** Jobs still downloading or transcribing; never swept regardless of age. */
  private readonly activeJobs = new Set<string>();
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly options: TranscriptionAdapterConfig) {
    this.config = ConfigSchema.parse({
      workspaceDir: options.workspaceDir,
      allowedHosts: options.allowedHosts,
      maxBytes: options.maxBytes ?? 500 * 1024 * 1024,
      maxDurationSeconds: options.maxDurationSeconds ?? 4 * 60 * 60,
      maxWorkspaceBytes: options.maxWorkspaceBytes ?? 2 * 1024 * 1024 * 1024,
      maxConcurrency: options.maxConcurrency ?? 1,
      timeoutMs: options.timeoutMs ?? 60 * 60 * 1000,
      retentionMs: options.retentionMs ?? 24 * 60 * 60 * 1000,
    });
    const scratch = options.provider.maxScratchBytes ?? 0;
    if (
      !Number.isSafeInteger(scratch) ||
      scratch < 0 ||
      this.config.maxBytes + scratch > this.config.maxWorkspaceBytes
    ) {
      throw new RangeError("download and provider scratch must fit maxWorkspaceBytes");
    }
    this.hosts = new Set(this.config.allowedHosts.map((h) => h.toLowerCase()));
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.removeDirectory =
      options.removeDirectory ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  /**
   * Transcribe the first usable candidate, audio before video. A candidate
   * that is refused or fails to download moves on to the next; provider
   * failures and cancellation stop immediately.
   */
  async transcribe(candidates: MediaCandidate[], signal?: AbortSignal): Promise<TranscriptionJob> {
    const ordered = [...candidates].sort(
      (a, b) => Number(a.kind === "video") - Number(b.kind === "video"),
    );
    if (ordered.length === 0) throw new TranscriptionError("download-failed", false);
    let lastError: TranscriptionError | undefined;
    for (const candidate of ordered) {
      try {
        return await this.transcribeOne(candidate, signal);
      } catch (error) {
        const failure =
          error instanceof TranscriptionError
            ? error
            : new TranscriptionError("provider-failed", true);
        lastError = failure;
        const tryNext = ["too-long", "too-large", "destination-refused", "download-failed"];
        if (!tryNext.includes(failure.reason)) throw failure;
      }
    }
    throw lastError!;
  }

  private async acquireSlot(signal: AbortSignal): Promise<void> {
    while (this.active >= this.config.maxConcurrency) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          // Leave the queue so a later release wakes a live waiter, not this one.
          const at = this.waiters.indexOf(wake);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(new TranscriptionError("cancelled", false));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(wake);
      });
    }
    this.active++;
  }

  private releaseSlot(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  private async transcribeOne(
    candidate: MediaCandidate,
    outer?: AbortSignal,
  ): Promise<TranscriptionJob> {
    if (
      candidate.durationSeconds !== undefined &&
      candidate.durationSeconds > this.config.maxDurationSeconds
    ) {
      throw new TranscriptionError("too-long", false);
    }
    let url: URL;
    try {
      url = new URL(candidate.url);
      assertAllowedDestination(url, this.hosts);
    } catch {
      throw new TranscriptionError("destination-refused", false);
    }

    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
    const reason = () =>
      outer?.aborted
        ? new TranscriptionError("cancelled", false)
        : new TranscriptionError("timeout", true);

    try {
      await this.acquireSlot(signal);
    } catch {
      throw reason();
    }
    const foreign = await this.foreignBytes().catch(() => {
      this.releaseSlot();
      throw new TranscriptionError("workspace-full", true);
    });
    const reservationBytes = this.config.maxBytes + (this.options.provider.maxScratchBytes ?? 0);
    if (foreign + this.reservedBytes + reservationBytes > this.config.maxWorkspaceBytes) {
      this.releaseSlot();
      throw new TranscriptionError("workspace-full", true);
    }
    this.reservedBytes += reservationBytes;
    const jobName = `job-${randomUUID()}`;
    const jobDir = join(this.config.workspaceDir, jobName);
    // The concurrency slot covers download and transcription only; the disk
    // reservation lasts until the media is deleted.
    // A provider that ignores cancellation keeps running after a timeout, so
    // the slot is only returned once its call has actually settled.
    let providerSettled: Promise<void> = Promise.resolve();
    let slotHeld = true;
    const freeSlot = () => {
      if (!slotHeld) return;
      slotHeld = false;
      void providerSettled.then(() => this.releaseSlot());
    };
    let released = false;
    const release = async () => {
      freeSlot();
      if (released) return;
      // Mark released only after the media is actually gone, so a failed
      // deletion can be retried by calling cleanup again (or by a sweep).
      await this.removeDirectory(jobDir);
      if (released) return;
      released = true;
      this.ownJobs.delete(jobName);
      this.activeJobs.delete(jobName);
      this.reservedBytes -= reservationBytes;
    };
    this.ownJobs.set(jobName, release);
    this.activeJobs.add(jobName);

    try {
      await mkdir(jobDir, { recursive: true, mode: 0o700 });
      const path = join(jobDir, candidate.kind === "audio" ? "media.audio" : "media.video");
      await this.download(url, path, signal).catch((error: unknown) => {
        if (signal.aborted) throw reason();
        throw error;
      });
      let result: ProviderResult;
      try {
        // Race the provider against cancellation/timeout so a provider that
        // ignores its signal cannot hold the job past the bound.
        let onAbort: () => void = () => {};
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(reason());
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          const call = this.options.provider.transcribe(
            { path, kind: candidate.kind, durationSeconds: candidate.durationSeconds },
            signal,
          );
          providerSettled = Promise.resolve(call).then(
            () => undefined,
            () => undefined,
          );
          const raw = await Promise.race([call, aborted]);
          // 1: validate provider output at the boundary.
          const parsed = ProviderResultSchema.safeParse(raw);
          if (!parsed.success) throw new TranscriptionError("provider-failed", false);
          result = parsed.data;
        } finally {
          signal.removeEventListener("abort", onAbort);
          aborted.catch(() => undefined);
        }
      } catch (error) {
        if (error instanceof TranscriptionError) throw error;
        throw signal.aborted ? reason() : new TranscriptionError("provider-failed", true);
      }
      freeSlot();
      // Download and transcription are done; the job now only awaits cleanup.
      this.activeJobs.delete(jobName);
      const segments = result.segments
        .map((s) => ({ ...s, text: s.text.trim() }))
        .filter((s) => s.text.length > 0);
      const text = segments.map((s) => s.text).join(" ");
      if (!text) throw new TranscriptionError("empty-transcript", false);
      const timestamped = segments.every(
        (s) => typeof s.start === "number" && typeof s.end === "number",
      );
      return {
        transcript: {
          text,
          segments,
          timestamped,
          language: result.language,
          provider: this.options.provider.name,
          model: this.options.provider.model,
          mediaKind: candidate.kind,
          mediaUrl: candidate.url,
          confidence: result.confidence,
          complete: result.complete ?? false,
          machineGenerated: true,
        },
        cleanup: release,
      };
    } catch (error) {
      // The job is no longer active, so a sweep may remove it if this
      // deletion fails; report the original failure, not the cleanup error.
      this.activeJobs.delete(jobName);
      await release().catch(() => undefined);
      throw error;
    }
  }

  /** Stream media to disk with an allowlisted redirect chain and a hard size cap. */
  private async download(start: URL, path: string, signal: AbortSignal): Promise<void> {
    let url = start;
    let response: Response | undefined;
    for (let hop = 0; hop <= 3; hop++) {
      try {
        assertAllowedDestination(url, this.hosts);
      } catch {
        throw new TranscriptionError("destination-refused", false);
      }
      try {
        response = await this.fetch(url, { redirect: "manual", signal });
      } catch {
        throw new TranscriptionError("download-failed", true);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new TranscriptionError("download-failed", false);
        try {
          url = new URL(location, url);
        } catch {
          throw new TranscriptionError("download-failed", false);
        }
        continue;
      }
      break;
    }
    if (!response || response.status >= 300) {
      await response?.body?.cancel();
      const status = response?.status ?? 500;
      throw new TranscriptionError("download-failed", status >= 500 || status === 429);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.config.maxBytes) {
      await response.body?.cancel();
      throw new TranscriptionError("too-large", false);
    }
    if (!response.body) throw new TranscriptionError("download-failed", true);
    let written = 0;
    const max = this.config.maxBytes;
    const limited = Readable.fromWeb(response.body as never).filter((chunk: Buffer) => {
      written += chunk.length;
      if (written > max) throw new TranscriptionError("too-large", false);
      return true;
    });
    try {
      await pipeline(limited, createWriteStream(path, { mode: 0o600 }), { signal });
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError("download-failed", true);
    }
  }

  /** Bytes held by job directories this instance did not create (e.g. before a restart). */
  private async foreignBytes(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.config.workspaceDir);
    } catch {
      return 0;
    }
    const bytes = async (path: string, depth = 0): Promise<number> => {
      if (depth > 8) throw new TranscriptionError("workspace-full", true);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) throw new TranscriptionError("workspace-full", true);
        if (info.isFile()) return info.size;
        if (!info.isDirectory()) throw new TranscriptionError("workspace-full", true);
        let total = 0;
        for (const file of await readdir(path)) {
          total += await bytes(join(path, file), depth + 1);
          if (total >= this.config.maxWorkspaceBytes) break;
        }
        return total;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    };
    let total = 0;
    for (const entry of entries) {
      if (!entry.startsWith("job-") || this.ownJobs.has(entry)) continue;
      total += await bytes(join(this.config.workspaceDir, entry));
      if (total >= this.config.maxWorkspaceBytes) break;
    }
    return total;
  }

  /**
   * Delete temporary media older than the retention period, including files
   * left by a crashed process. Returns the number of job directories removed.
   */
  async sweepExpired(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.config.workspaceDir);
    } catch {
      return 0;
    }
    let removed = 0;
    const cutoff = this.now() - this.config.retentionMs;
    for (const entry of entries) {
      if (!entry.startsWith("job-") || this.activeJobs.has(entry)) continue;
      const dir = join(this.config.workspaceDir, entry);
      try {
        if ((await stat(dir)).mtimeMs <= cutoff) {
          // An expired job of this instance goes through its own release so
          // its disk reservation and slot are returned too.
          const own = this.ownJobs.get(entry);
          if (own) await own();
          else await rm(dir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // Already gone or unreadable; the next sweep retries.
      }
    }
    return removed;
  }
}
