import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  TranscriptionAdapter,
  TranscriptionError,
  type MediaCandidate,
  type TranscriptionAdapterConfig,
  type TranscriptionProvider,
} from "../../src/transcription/adapter.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-transcribe-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const AUDIO: MediaCandidate = {
  kind: "audio",
  url: "https://media.test/a.mp3",
  durationSeconds: 60,
};
const VIDEO: MediaCandidate = {
  kind: "video",
  url: "https://media.test/v.mp4",
  durationSeconds: 60,
};

type Route = number | Uint8Array | (() => Response | Promise<Response>);
function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (init?.signal?.aborted) throw init.signal.reason;
    if (route === undefined) return new Response("", { status: 404 });
    if (typeof route === "number") return new Response("", { status: route });
    if (typeof route === "function") return route();
    return new Response(route);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function provider(
  behaviour: (input: { path: string; kind: string }) => Promise<unknown> | unknown = () => ({
    segments: [
      { text: " Hello ", start: 0, end: 1.5 },
      { text: "world.", start: 1.5, end: 2 },
    ],
    language: "en",
    confidence: 0.9,
    complete: true,
  }),
) {
  const seen: Array<{ kind: string; bytes: string }> = [];
  const p: TranscriptionProvider = {
    name: "fake",
    model: "fake-1",
    async transcribe(input, signal) {
      seen.push({ kind: input.kind, bytes: await readFile(input.path, "utf8") });
      signal.throwIfAborted();
      return (await behaviour(input)) as never;
    },
  };
  return { p, seen };
}

function adapter(extra: Partial<TranscriptionAdapterConfig>, routes: Record<string, Route>) {
  const fake = fakeFetch(routes);
  const prov = extra.provider ? { p: extra.provider, seen: [] } : provider();
  const a = new TranscriptionAdapter({
    provider: prov.p,
    workspaceDir: dir,
    allowedHosts: ["media.test"],
    maxBytes: 1024,
    maxWorkspaceBytes: 4096,
    fetch: fake.fetch,
    ...extra,
  });
  return { a, calls: fake.calls, seen: prov.seen };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const jobs = async () => (await readdir(dir)).filter((e) => e.startsWith("job-"));

describe("TranscriptionAdapter", () => {
  it("transcribes audio with provenance and keeps media until cleanup", async () => {
    const { a, seen } = adapter({}, { [AUDIO.url]: bytes("AUDIO") });
    const job = await a.transcribe([VIDEO, AUDIO]);
    expect(job.transcript).toEqual({
      text: "Hello world.",
      segments: [
        { text: "Hello", start: 0, end: 1.5 },
        { text: "world.", start: 1.5, end: 2 },
      ],
      timestamped: true,
      language: "en",
      provider: "fake",
      model: "fake-1",
      mediaKind: "audio",
      mediaUrl: AUDIO.url,
      confidence: 0.9,
      complete: true,
      machineGenerated: true,
    });
    expect(seen).toEqual([{ kind: "audio", bytes: "AUDIO" }]);
    expect(await jobs()).toHaveLength(1);
    await job.cleanup();
    await job.cleanup();
    expect(await jobs()).toHaveLength(0);
  });

  it("falls back to video only when audio is unusable", async () => {
    const { a, calls } = adapter({}, { [VIDEO.url]: bytes("VIDEO") });
    const job = await a.transcribe([AUDIO, VIDEO]);
    expect(job.transcript.mediaKind).toBe("video");
    expect(job.transcript.mediaUrl).toBe(VIDEO.url);
    expect(calls).toEqual([AUDIO.url, VIDEO.url]);
    await job.cleanup();
  });

  it("does not invent timestamps", async () => {
    const { p } = provider(() => ({ segments: [{ text: "No times." }] }));
    const { a } = adapter({ provider: p }, { [AUDIO.url]: bytes("A") });
    const job = await a.transcribe([AUDIO]);
    expect(job.transcript).toMatchObject({ timestamped: false, complete: false });
    expect(job.transcript.segments[0]).toEqual({ text: "No times." });
    await job.cleanup();
  });

  it("refuses over-long media before downloading", async () => {
    const { a, calls } = adapter({ maxDurationSeconds: 30 }, { [AUDIO.url]: bytes("A") });
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "too-long" });
    expect(calls).toHaveLength(0);
  });

  it("enforces the size bound during download and deletes the partial file", async () => {
    const { a } = adapter({}, { [AUDIO.url]: bytes("x".repeat(2048)) });
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "too-large" });
    expect(await jobs()).toHaveLength(0);
  });

  it("refuses destinations and redirects outside the allowlist", async () => {
    const { a, calls } = adapter(
      {},
      {
        [AUDIO.url]: () =>
          new Response(null, { status: 302, headers: { location: "https://evil.test/a" } }),
      },
    );
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "destination-refused" });
    expect(calls).toEqual([AUDIO.url]);
    await expect(
      a.transcribe([{ kind: "audio", url: "http://media.test/a.mp3" }]),
    ).rejects.toMatchObject({ reason: "destination-refused" });
  });

  it("reports provider failure, deletes media and does not try video", async () => {
    const { p } = provider(() => {
      throw new Error("provider said https://secret.example");
    });
    const { a, calls } = adapter(
      { provider: p },
      { [AUDIO.url]: bytes("A"), [VIDEO.url]: bytes("V") },
    );
    const error = await a.transcribe([AUDIO, VIDEO]).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "provider-failed", retryable: true });
    expect(String(error)).not.toContain("secret");
    expect(calls).toEqual([AUDIO.url]);
    expect(await jobs()).toHaveLength(0);
  });

  it("rejects an empty transcript", async () => {
    const { p } = provider(() => ({ segments: [{ text: "   " }] }));
    const { a } = adapter({ provider: p }, { [AUDIO.url]: bytes("A") });
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "empty-transcript" });
    expect(await jobs()).toHaveLength(0);
  });

  it("honours cancellation and cleans up", async () => {
    const abort = new AbortController();
    const { p } = provider(async () => {
      abort.abort();
      throw new Error("aborted");
    });
    const { a } = adapter({ provider: p }, { [AUDIO.url]: bytes("A") });
    await expect(a.transcribe([AUDIO], abort.signal)).rejects.toMatchObject({
      reason: "cancelled",
    });
    expect(await jobs()).toHaveLength(0);
  });

  it("bounds concurrency and total workspace use", async () => {
    let running = 0;
    let peak = 0;
    let releaseFirst: () => void = () => {};
    const { p } = provider(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => (releaseFirst = r));
      running--;
      return { segments: [{ text: "ok" }] };
    });
    const { a } = adapter({ provider: p, maxConcurrency: 1 }, { [AUDIO.url]: bytes("A") });
    const first = a.transcribe([AUDIO]);
    const second = a.transcribe([AUDIO]);
    for (let i = 0; i < 50 && running === 0; i++) await new Promise((r) => setImmediate(r));
    releaseFirst();
    const job1 = await first;
    for (let i = 0; i < 50 && running === 0; i++) await new Promise((r) => setImmediate(r));
    releaseFirst();
    const job2 = await second;
    expect(peak).toBe(1);
    await job1.cleanup();
    await job2.cleanup();

    const full = adapter(
      { maxBytes: 1024, maxWorkspaceBytes: 1024, maxConcurrency: 2 },
      { [AUDIO.url]: bytes("A") },
    ).a;
    const held = await full.transcribe([AUDIO]);
    await expect(full.transcribe([AUDIO])).rejects.toMatchObject({ reason: "workspace-full" });
    await held.cleanup();
  });

  it.each([
    ["missing segments", { language: "en" }],
    ["non-string text", { segments: [{ text: 42 }] }],
    ["negative time", { segments: [{ text: "x", start: -1, end: 2 }] }],
    ["end before start", { segments: [{ text: "x", start: 5, end: 2 }] }],
    ["confidence out of range", { segments: [{ text: "x" }], confidence: 7 }],
  ])("rejects malformed provider output (%s) and cleans up", async (_name, output) => {
    const { p } = provider(() => output);
    const { a } = adapter({ provider: p }, { [AUDIO.url]: bytes("A") });
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({
      reason: "provider-failed",
      retryable: false,
    });
    expect(await jobs()).toHaveLength(0);
  });

  it("enforces the timeout even when the provider ignores its signal", async () => {
    const p: TranscriptionProvider = {
      name: "hung",
      model: "hung-1",
      transcribe: () => new Promise(() => {}),
    };
    const { a } = adapter({ provider: p, timeoutMs: 50 }, { [AUDIO.url]: bytes("A") });
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "timeout" });
    expect(await jobs()).toHaveLength(0);
  });

  it("removes cancelled waiters so the next live job gets the slot", async () => {
    let releaseFirst: () => void = () => {};
    let calls = 0;
    const { p } = provider(async () => {
      calls++;
      if (calls === 1) await new Promise<void>((r) => (releaseFirst = r));
      return { segments: [{ text: "ok" }] };
    });
    const { a } = adapter({ provider: p, maxConcurrency: 1 }, { [AUDIO.url]: bytes("A") });
    const first = a.transcribe([AUDIO]);
    for (let i = 0; i < 50 && calls === 0; i++) await new Promise((r) => setImmediate(r));
    const cancel = new AbortController();
    const cancelled = a.transcribe([AUDIO], cancel.signal);
    const third = a.transcribe([AUDIO]);
    cancel.abort();
    await expect(cancelled).rejects.toMatchObject({ reason: "cancelled" });
    releaseFirst();
    await (await first).cleanup();
    const job3 = await third;
    expect(job3.transcript.text).toBe("ok");
    await job3.cleanup();
  });

  it("counts media surviving from a previous process against the workspace budget", async () => {
    const survivor = join(dir, "job-previous");
    await mkdir(survivor);
    await writeFile(join(survivor, "media.audio"), "x".repeat(3500));
    const { a } = adapter({ maxBytes: 1024, maxWorkspaceBytes: 4096 }, { [AUDIO.url]: bytes("A") });
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "workspace-full" });
    await rm(survivor, { recursive: true });
    const job = await a.transcribe([AUDIO]);
    await job.cleanup();
  });

  it("releases the reservation when sweeping its own expired job", async () => {
    let clock = Date.now();
    const { a } = adapter(
      { maxBytes: 1024, maxWorkspaceBytes: 1024, retentionMs: 1_000, now: () => clock },
      { [AUDIO.url]: bytes("A") },
    );
    await a.transcribe([AUDIO]); // caller never cleans up
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "workspace-full" });
    clock += 60_000;
    expect(await a.sweepExpired()).toBe(1);
    const job = await a.transcribe([AUDIO]);
    await job.cleanup();
  });

  it("never sweeps a job that is still transcribing", async () => {
    let clock = Date.now();
    let finish: () => void = () => {};
    let started = false;
    const { p } = provider(async () => {
      started = true;
      await new Promise<void>((r) => (finish = r));
      return { segments: [{ text: "done" }] };
    });
    const { a } = adapter(
      { provider: p, retentionMs: 1_000, now: () => clock },
      { [AUDIO.url]: bytes("A") },
    );
    const pending = a.transcribe([AUDIO]);
    for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setImmediate(r));
    clock += 60_000;
    expect(await a.sweepExpired()).toBe(0);
    expect(await jobs()).toHaveLength(1);
    finish();
    const job = await pending;
    expect(job.transcript.text).toBe("done");
    await job.cleanup();
  });

  it("classifies a malformed redirect as a download failure", async () => {
    const { a } = adapter(
      {},
      {
        [AUDIO.url]: () => new Response(null, { status: 302, headers: { location: "https://[" } }),
      },
    );
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "download-failed" });
    expect(await jobs()).toHaveLength(0);
  });

  it("lets a sweep remove a failed job whose cleanup failed", async () => {
    let clock = Date.now();
    let failRemovals = 1;
    const { rm: realRm } = await import("node:fs/promises");
    const { p } = provider(() => {
      throw new Error("provider down");
    });
    const { a } = adapter(
      {
        provider: p,
        retentionMs: 1_000,
        now: () => clock,
        removeDirectory: async (path) => {
          if (failRemovals-- > 0) throw new Error("EBUSY");
          await realRm(path, { recursive: true, force: true });
        },
      },
      { [AUDIO.url]: bytes("A") },
    );
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "provider-failed" });
    expect(await jobs()).toHaveLength(1);
    clock += 60_000;
    expect(await a.sweepExpired()).toBe(1);
    expect(await jobs()).toHaveLength(0);
  });

  it("keeps a timed-out provider call within the concurrency bound", async () => {
    let running = 0;
    let peak = 0;
    let finishHung: () => void = () => {};
    let calls = 0;
    const p: TranscriptionProvider = {
      name: "slow",
      model: "slow-1",
      transcribe: async () => {
        calls++;
        running++;
        peak = Math.max(peak, running);
        if (calls === 1) await new Promise<void>((r) => (finishHung = r));
        running--;
        return { segments: [{ text: "ok" }] };
      },
    };
    const { a } = adapter(
      { provider: p, maxConcurrency: 1, timeoutMs: 150 },
      { [AUDIO.url]: bytes("A") },
    );
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "timeout" });
    const second = a.transcribe([AUDIO]);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1); // still waiting for the hung call to finish
    finishHung();
    const job = await second;
    expect(peak).toBe(1);
    await job.cleanup();
  });

  it("treats a rate-limited download as retryable", async () => {
    const { a } = adapter({}, { [AUDIO.url]: 429 });
    await expect(a.transcribe([AUDIO])).rejects.toMatchObject({
      reason: "download-failed",
      retryable: true,
    });
  });

  it("sweeps abandoned media left by a crashed process", async () => {
    const clock = Date.now();
    const old = join(dir, "job-crashed");
    const fresh = join(dir, "job-current");
    await mkdir(old);
    await mkdir(fresh);
    const past = new Date(clock - 2 * 3_600_000);
    await utimes(old, past, past);
    const { a } = adapter({ retentionMs: 3_600_000, now: () => clock }, {});
    expect(await a.sweepExpired()).toBe(1);
    expect((await jobs()).sort()).toEqual(["job-current"]);
  });

  it("validates configuration", () => {
    const base = { provider: provider().p, allowedHosts: ["media.test"] };
    expect(() => new TranscriptionAdapter({ ...base, workspaceDir: "relative" })).toThrow();
    expect(
      () =>
        new TranscriptionAdapter({
          ...base,
          workspaceDir: dir,
          maxBytes: 10,
          maxWorkspaceBytes: 5,
        }),
    ).toThrow(RangeError);
    expect(
      () => new TranscriptionAdapter({ ...base, workspaceDir: dir, allowedHosts: [] }),
    ).toThrow();
  });

  it("is an error type with a reason", () => {
    expect(new TranscriptionError("timeout", true)).toMatchObject({
      reason: "timeout",
      retryable: true,
    });
  });
});

it("reserves provider conversion scratch alongside retained original media", async () => {
  const fake = fakeFetch({ [AUDIO.url]: bytes("A") });
  const p = { ...provider().p, maxScratchBytes: 2048 };
  const a = new TranscriptionAdapter({
    provider: p,
    workspaceDir: dir,
    allowedHosts: ["media.test"],
    maxBytes: 1024,
    maxWorkspaceBytes: 4096,
    fetch: fake.fetch,
  });
  const first = await a.transcribe([AUDIO]);
  await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "workspace-full" });
  await first.cleanup();
  const second = await a.transcribe([AUDIO]);
  await second.cleanup();
  expect(await jobs()).toHaveLength(0);
});

it("rejects provider scratch budgets that cannot fit before accepting media", () => {
  expect(
    () =>
      new TranscriptionAdapter({
        provider: { ...provider().p, maxScratchBytes: 4096 },
        workspaceDir: dir,
        allowedHosts: ["media.test"],
        maxBytes: 1024,
        maxWorkspaceBytes: 4096,
      }),
  ).toThrow("download and provider scratch");
});

it("counts nested conversion scratch surviving a restart", async () => {
  const scratch = join(dir, "job-crashed", "whisper-scratch");
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, "input.wav"), "x".repeat(3500));
  const { a } = adapter({}, { [AUDIO.url]: bytes("A") });
  await expect(a.transcribe([AUDIO])).rejects.toMatchObject({ reason: "workspace-full" });
  await rm(join(dir, "job-crashed"), { recursive: true });
  const job = await a.transcribe([AUDIO]);
  await job.cleanup();
});
