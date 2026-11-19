import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  WhisperProvider,
  runWhisperCommand,
  type WhisperRunner,
} from "../../src/transcription/whisper.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-whisper-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const normal = () => ({
  result: { language: "en" },
  transcription: [{ text: " Hello world. ", offsets: { from: 250, to: 1500 } }],
});
function setup(options: { output?: unknown; duration?: string; fail?: string } = {}) {
  const calls: { binary: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: WhisperRunner = async (binary, args, { signal, env }) => {
    signal.throwIfAborted();
    calls.push({ binary, args, env });
    if (binary === options.fail) throw new Error("sensitive command diagnostics");
    if (binary === "ffmpeg") await writeFile(args.at(-1)!, "wav");
    if (binary === "ffprobe")
      return JSON.stringify({ format: { duration: options.duration ?? "2.0" } });
    if (binary === "whisper-cli") {
      const prefix = args[args.indexOf("--output-file") + 1];
      await writeFile(`${prefix}.json`, JSON.stringify(options.output ?? normal()));
    }
    return "";
  };
  const provider = new WhisperProvider({
    modelPath: "/models/model.bin",
    model: "test-model-v1",
    run,
  });
  return { provider, calls };
}
const signal = () => new AbortController().signal;

describe("WhisperProvider", () => {
  it("returns timed segments in seconds, CPU-only, with only whitelisted environment", async () => {
    const { provider, calls } = setup();
    const input = join(dir, "source;literal.mp3");
    const result = await provider.transcribe({ path: input, kind: "audio" }, signal());
    expect(result).toEqual({
      segments: [{ text: "Hello world.", start: 0.25, end: 1.5 }],
      language: "en",
      complete: true,
    });
    expect(provider.name).toBe("whisper.cpp");
    expect(provider.model).toBe("test-model-v1");
    expect(calls[0].args).toContain(input);
    expect(calls[0].args).toContain("-xerror");
    expect(calls[2].args).toContain("--no-gpu");
    expect(calls[2].args).not.toContain("--duration");
    expect(Object.keys(calls[2].env).sort()).toEqual(["LANG", "LC_ALL", "PATH"]);
    expect(await readdir(dir)).toEqual([]);
  });

  it.each(["ffmpeg", "ffprobe", "whisper-cli"])(
    "redacts %s errors and deletes conversion files",
    async (fail) => {
      const { provider } = setup({ fail });
      const error = await provider
        .transcribe({ path: join(dir, "source"), kind: "audio" }, signal())
        .catch((e) => e);
      expect(error.reason).toBe("provider-failed");
      expect(String(error)).not.toMatch(/sensitive|models|source/);
      expect(await readdir(dir)).toEqual([]);
    },
  );

  it.each([
    { result: { language: "en" }, transcription: [] },
    {
      result: { language: "en" },
      transcription: [{ text: "bad", offsets: { from: 1000, to: 0 } }],
    },
    {
      result: { language: "en" },
      transcription: [{ text: "bad", offsets: { from: 0, to: 100000 } }],
    },
    { result: { language: "en" }, transcription: [{ text: " ", offsets: { from: 0, to: 1000 } }] },
  ])("rejects malformed or implausible output without retaining scratch files", async (output) => {
    const { provider } = setup({ output });
    await expect(
      provider.transcribe({ path: join(dir, "source"), kind: "audio" }, signal()),
    ).rejects.toMatchObject({ reason: "provider-failed" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects oversized duration instead of claiming a truncated result is complete", async () => {
    const { provider, calls } = setup({ duration: "14401" });
    await expect(
      provider.transcribe({ path: join(dir, "source"), kind: "audio" }, signal()),
    ).rejects.toMatchObject({ reason: "too-long", retryable: false });
    expect(calls).toHaveLength(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it("cancels after conversion without invoking inference and cleans scratch", async () => {
    const abort = new AbortController();
    const run: WhisperRunner = async (_binary, args, options) => {
      options.signal.throwIfAborted();
      await writeFile(args.at(-1)!, "partial");
      abort.abort();
      throw new Error("cancelled");
    };
    const provider = new WhisperProvider({ modelPath: "/models/model.bin", model: "test", run });
    await expect(
      provider.transcribe({ path: join(dir, "source"), kind: "audio" }, abort.signal),
    ).rejects.toMatchObject({ reason: "provider-failed" });
    expect(await readdir(dir)).toEqual([]);
  });
});

it("terminates a real child on cancellation, suppressing its diagnostics", async () => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    await expect(
      runWhisperCommand(
        process.execPath,
        ["-e", "process.stderr.write('sensitive'); setInterval(()=>{},1000)"],
        {
          signal: abort.signal,
          maxBuffer: 4096,
          env: {},
        },
      ),
    ).rejects.toMatchObject({ reason: "provider-failed" });
  } finally {
    clearTimeout(timer);
  }
});

it("does not archive a no-speech marker as a successful transcript", async () => {
  const { provider } = setup({
    output: {
      result: { language: "en" },
      transcription: [{ text: "[BLANK_AUDIO]", offsets: { from: 0, to: 1000 } }],
    },
  });
  await expect(
    provider.transcribe({ path: join(dir, "source"), kind: "audio" }, signal()),
  ).rejects.toMatchObject({ reason: "empty-transcript", retryable: false });
  expect(await readdir(dir)).toEqual([]);
});

it.skipIf(spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0)(
  "rejects a downloaded HLS playlist that references a local file",
  async () => {
    const jobDir = join(dir, "job");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(jobDir);
    const outside = join(dir, "private-recording.ts");
    const generated = spawnSync(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:a",
        "aac",
        "-f",
        "mpegts",
        outside,
      ],
      { stdio: "ignore" },
    );
    expect(generated.status).toBe(0);
    const playlist = join(jobDir, "media.audio");
    await writeFile(
      playlist,
      `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:1,\n${outside}\n#EXT-X-ENDLIST\n`,
    );
    const calls: string[] = [];
    const provider = new WhisperProvider({
      modelPath: "/models/model.bin",
      model: "test",
      run: async (binary, args, options) => {
        calls.push(binary);
        return runWhisperCommand(binary, args, options);
      },
    });
    await expect(
      provider.transcribe({ path: playlist, kind: "audio" }, signal()),
    ).rejects.toMatchObject({ reason: "provider-failed" });
    expect(calls).toEqual(["ffmpeg"]);
    expect(await readdir(jobDir)).toEqual(["media.audio"]);
  },
);
