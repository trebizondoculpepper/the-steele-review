import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { TranscriptionAdapter } from "../transcription/adapter.js";
import { WhisperProvider } from "../transcription/whisper.js";

const absolute = z.string().refine(isAbsolute);
const Config = z.object({
  STEELE_WHISPER_MODEL_PATH: absolute,
  STEELE_WHISPER_MODEL: z.string().min(1).max(200),
  STEELE_TRANSCRIPTION_WORKSPACE: absolute,
  STEELE_TRANSCRIPTION_ALLOWED_HOSTS: z.string().min(1),
  STEELE_WHISPER_BINARY: absolute.default("/usr/local/bin/whisper-cli"),
  STEELE_FFMPEG_BINARY: absolute.default("/usr/bin/ffmpeg"),
  STEELE_FFPROBE_BINARY: absolute.default("/usr/bin/ffprobe"),
  STEELE_WHISPER_THREADS: z.coerce.number().int().min(1).max(16).default(2),
  STEELE_TRANSCRIPTION_MAX_DURATION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(14400)
    .default(14400),
  STEELE_TRANSCRIPTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(86400000)
    .default(21600000),
});

/** Compose the optional provider; credentials are never passed to media tools. */
export async function configuredTranscription(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TranscriptionAdapter | undefined> {
  const provider = env.STEELE_TRANSCRIPTION_PROVIDER;
  if (!provider || provider === "disabled") return undefined;
  if (provider !== "whisper.cpp") throw new Error("invalid STEELE_TRANSCRIPTION_PROVIDER");
  const parsed = Config.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`invalid transcription configuration: ${fields.join(", ")}`);
  }
  const c = parsed.data;
  const allowedHosts = c.STEELE_TRANSCRIPTION_ALLOWED_HOSTS.split(",").map((h) =>
    h.trim().toLowerCase(),
  );
  if (allowedHosts.some((h) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h))) {
    throw new Error("invalid STEELE_TRANSCRIPTION_ALLOWED_HOSTS");
  }
  try {
    await access(c.STEELE_WHISPER_MODEL_PATH, constants.R_OK);
    for (const binary of [
      c.STEELE_WHISPER_BINARY,
      c.STEELE_FFMPEG_BINARY,
      c.STEELE_FFPROBE_BINARY,
    ]) {
      await access(binary, constants.X_OK);
    }
    await mkdir(c.STEELE_TRANSCRIPTION_WORKSPACE, { recursive: true, mode: 0o700 });
    await access(c.STEELE_TRANSCRIPTION_WORKSPACE, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error("local transcription model, executables or workspace unavailable");
  }
  const adapter = new TranscriptionAdapter({
    provider: new WhisperProvider({
      modelPath: c.STEELE_WHISPER_MODEL_PATH,
      model: c.STEELE_WHISPER_MODEL,
      whisperBinary: c.STEELE_WHISPER_BINARY,
      ffmpegBinary: c.STEELE_FFMPEG_BINARY,
      ffprobeBinary: c.STEELE_FFPROBE_BINARY,
      threads: c.STEELE_WHISPER_THREADS,
      maxDurationSeconds: c.STEELE_TRANSCRIPTION_MAX_DURATION_SECONDS,
    }),
    workspaceDir: c.STEELE_TRANSCRIPTION_WORKSPACE,
    allowedHosts,
    maxConcurrency: 1,
    maxDurationSeconds: c.STEELE_TRANSCRIPTION_MAX_DURATION_SECONDS,
    timeoutMs: c.STEELE_TRANSCRIPTION_TIMEOUT_MS,
    retentionMs: 24 * 60 * 60 * 1000,
  });
  await adapter.sweepExpired();
  return adapter;
}
