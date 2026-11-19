import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { configuredTranscription } from "../../src/config/transcription.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-whisper-config-"));
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

it("leaves ordinary collection unchanged unless explicitly enabled", async () => {
  expect(await configuredTranscription({})).toBeUndefined();
  expect(
    await configuredTranscription({ STEELE_TRANSCRIPTION_PROVIDER: "disabled" }),
  ).toBeUndefined();
});
it("reports missing fields without disclosing configured paths", async () => {
  const error = await configuredTranscription({
    STEELE_TRANSCRIPTION_PROVIDER: "whisper.cpp",
    STEELE_WHISPER_MODEL_PATH: "/private-sentinel/model",
  }).catch((e) => e);
  expect(String(error)).toContain("STEELE_TRANSCRIPTION_WORKSPACE");
  expect(String(error)).not.toContain("private-sentinel");
});
it("rejects unknown providers", async () => {
  await expect(
    configuredTranscription({ STEELE_TRANSCRIPTION_PROVIDER: "unsupported" }),
  ).rejects.toThrow("invalid STEELE_TRANSCRIPTION_PROVIDER");
});
async function validEnv(): Promise<NodeJS.ProcessEnv> {
  const binary = join(dir, "binary");
  await writeFile(binary, "stub");
  await chmod(binary, 0o700);
  const model = join(dir, "model.bin");
  await writeFile(model, "model");
  return {
    STEELE_TRANSCRIPTION_PROVIDER: "whisper.cpp",
    STEELE_WHISPER_MODEL_PATH: model,
    STEELE_WHISPER_MODEL: "model-v1",
    STEELE_TRANSCRIPTION_WORKSPACE: join(dir, "work"),
    STEELE_TRANSCRIPTION_ALLOWED_HOSTS: "audio.example, cdn.example",
    STEELE_WHISPER_BINARY: binary,
    STEELE_FFMPEG_BINARY: binary,
    STEELE_FFPROBE_BINARY: binary,
  };
}
it("composes the provider with usable mounts and preserves active-age workspace files", async () => {
  const env = await validEnv();
  await mkdir(join(dir, "work", "job-recent"), { recursive: true });
  await writeFile(join(dir, "work", "job-recent", "media"), "pending");
  const adapter = await configuredTranscription(env);
  expect(adapter).toBeDefined();
  expect(await readdir(join(dir, "work"))).toEqual(["job-recent"]);
});
it("sanitises unreadable runtime dependencies", async () => {
  const env = await validEnv();
  env.STEELE_WHISPER_MODEL_PATH = join(dir, "secret-location-missing");
  const error = await configuredTranscription(env).catch((e) => e);
  expect(String(error)).toContain("unavailable");
  expect(String(error)).not.toContain("secret-location");
});
it("rejects URL-shaped allowlist values", async () => {
  const env = await validEnv();
  env.STEELE_TRANSCRIPTION_ALLOWED_HOSTS = "https://audio.example/path";
  await expect(configuredTranscription(env)).rejects.toThrow(
    "invalid STEELE_TRANSCRIPTION_ALLOWED_HOSTS",
  );
});
