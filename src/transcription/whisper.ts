import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { TranscriptionError, type ProviderResult, type TranscriptionProvider } from "./adapter.js";

/** Private subprocess transport. Never pass ambient credentials to media tools. */
export type WhisperRunner = (
  executable: string,
  args: string[],
  options: { signal: AbortSignal; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<string>;

export const runWhisperCommand: WhisperRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
    };
    const child = execFile(
      executable,
      args,
      { env: options.env, maxBuffer: options.maxBuffer, encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        options.signal.removeEventListener("abort", abort);
        if (killTimer) clearTimeout(killTimer);
        // Do not return stderr, paths or command arguments in public errors.
        if (error || options.signal.aborted)
          reject(new TranscriptionError("provider-failed", true));
        else resolve(stdout);
      },
    );
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdin?.end();
  });

const Config = z.object({
  modelPath: z.string().refine(isAbsolute),
  model: z.string().min(1).max(200),
  whisperBinary: z.string().min(1),
  ffmpegBinary: z.string().min(1),
  ffprobeBinary: z.string().min(1),
  threads: z.number().int().min(1).max(16),
  maxDurationSeconds: z
    .number()
    .positive()
    .max(24 * 60 * 60),
});
const Output = z.object({
  result: z.object({ language: z.string().min(2).max(32) }),
  transcription: z
    .array(
      z.object({
        text: z.string().min(1).max(100_000),
        offsets: z.object({
          from: z.number().finite().nonnegative(),
          to: z.number().finite().nonnegative(),
        }),
      }),
    )
    .min(1)
    .max(100_000),
});
const MAX_JSON_BYTES = 16 * 1024 * 1024;

export interface WhisperProviderConfig {
  /** Local externally provisioned weights; never downloaded by this controller. */
  modelPath: string;
  /** Stable model/version label recorded in provenance, not its filesystem path. */
  model: string;
  whisperBinary?: string;
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  threads?: number;
  maxDurationSeconds?: number;
  run?: WhisperRunner;
}

/** CPU-only whisper.cpp provider. All media subprocesses stay inside this boundary. */
export class WhisperProvider implements TranscriptionProvider {
  readonly name = "whisper.cpp";
  readonly model: string;
  private readonly config: z.infer<typeof Config>;
  private readonly run: WhisperRunner;

  constructor(options: WhisperProviderConfig) {
    const parsed = Config.safeParse({
      ...options,
      whisperBinary: options.whisperBinary ?? "whisper-cli",
      ffmpegBinary: options.ffmpegBinary ?? "ffmpeg",
      ffprobeBinary: options.ffprobeBinary ?? "ffprobe",
      threads: options.threads ?? 2,
      maxDurationSeconds: options.maxDurationSeconds ?? 4 * 60 * 60,
    });
    if (!parsed.success) throw new Error("invalid local transcription configuration");
    this.config = parsed.data;
    this.model = this.config.model;
    this.run = options.run ?? runWhisperCommand;
  }

  async transcribe(
    input: { path: string; kind: "audio" | "video" },
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    signal.throwIfAborted();
    if (!isAbsolute(input.path)) throw new TranscriptionError("provider-failed", false);
    const work = await mkdtemp(join(dirname(input.path), "whisper-"));
    try {
      const call = (binary: string, args: string[], maxBuffer = 256 * 1024) =>
        this.run(binary, args, {
          signal,
          maxBuffer,
          env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
        });
      const wav = join(work, "input.wav");
      // Decode at most one second beyond the permitted duration, then reject
      // rather than silently reporting a truncated transcription as complete.
      const max = this.config.maxDurationSeconds;
      await call(this.config.ffmpegBinary, [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        input.path,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-t",
        String(max + 1),
        "-fs",
        String(Math.ceil((max + 2) * 32_000 + 4096)),
        wav,
      ]);
      const durationOutput = await call(this.config.ffprobeBinary, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        wav,
      ]);
      const duration = Number(JSON.parse(durationOutput)?.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0)
        throw new TranscriptionError("provider-failed", false);
      if (duration > max) throw new TranscriptionError("too-long", false);
      if ((await stat(wav)).size > Math.ceil((max + 2) * 32_000 + 4096)) {
        throw new TranscriptionError("too-large", false);
      }
      const output = join(work, "transcript");
      await call(
        this.config.whisperBinary,
        [
          "--no-gpu",
          "--no-prints",
          "--threads",
          String(this.config.threads),
          "--model",
          this.config.modelPath,
          "--language",
          "en",
          "--file",
          wav,
          "--output-json",
          "--output-file",
          output,
        ],
        MAX_JSON_BYTES,
      );
      signal.throwIfAborted();
      if ((await stat(`${output}.json`)).size > MAX_JSON_BYTES)
        throw new TranscriptionError("too-large", false);
      const result = Output.parse(JSON.parse(await readFile(`${output}.json`, "utf8")));
      let previousStart = 0;
      const segments = result.transcription.map(({ text, offsets }) => {
        const start = offsets.from / 1_000;
        const end = offsets.to / 1_000;
        if (end < start || start < previousStart || end > duration + 1 || !text.trim()) {
          throw new TranscriptionError("provider-failed", false);
        }
        previousStart = start;
        return { text: text.trim(), start, end };
      });
      return { segments, language: result.result.language, complete: true };
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError("provider-failed", true);
    } finally {
      // Raw media remains owned by TranscriptionAdapter; only provider scratch
      // is removed here, including on malformed JSON, cancellation or failure.
      await rm(work, { recursive: true, force: true }).catch(() => {
        throw new TranscriptionError("provider-failed", true);
      });
    }
  }
}
