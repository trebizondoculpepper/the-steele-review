import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { configuredTranscription } from "../../src/config/transcription.js";
import { TranscriptionError } from "../../src/transcription/adapter.js";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  ENGLISH_TRANSCRIPTION_PROMPT,
  ENGLISH_TRANSCRIPTION_PROMPT_VERSION,
  ENGLISH_TRANSCRIPTION_USER,
  NO_SPEECH,
  OpenRouterTranscriptionProvider,
  sniffAudioFormat,
} from "../../src/transcription/openrouter.js";

let dir: string;
let audio: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-openrouter-stt-"));
  audio = join(dir, "clip.mp3");
  await writeFile(audio, Buffer.from("ID3 fake mp3 bytes"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = "test-key-not-real";
/** Fake OpenRouter endpoint recording each request. */
function endpoint(reply: { status?: number; content?: string | null; finish?: string }) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    if (reply.status && reply.status >= 400) return new Response("nope", { status: reply.status });
    return Response.json({
      model: DEFAULT_TRANSCRIPTION_MODEL,
      choices: [
        { finish_reason: reply.finish ?? "stop", message: { content: reply.content ?? null } },
      ],
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}
const signal = () => new AbortController().signal;

describe("English transcription through OpenRouter (#234)", () => {
  it("sends the audio inline with the explicit English instruction and returns the text", async () => {
    const { fetch, requests } = endpoint({ content: "  Right, so the IPCC have lied.  " });
    const provider = new OpenRouterTranscriptionProvider({ apiKey: KEY, fetch });
    const out = await provider.transcribe({ path: audio, kind: "audio" }, signal());
    expect(out).toEqual({
      segments: [{ text: "Right, so the IPCC have lied." }],
      language: "en",
      complete: true,
    });
    const [req] = requests;
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body.model).toBe(DEFAULT_TRANSCRIPTION_MODEL);
    expect(req.body.temperature).toBe(0);
    expect(req.body.messages[0]).toEqual({ role: "system", content: ENGLISH_TRANSCRIPTION_PROMPT });
    expect(ENGLISH_TRANSCRIPTION_PROMPT).toMatch(/English/);
    expect(ENGLISH_TRANSCRIPTION_PROMPT).toMatch(/Never translate/);
    expect(ENGLISH_TRANSCRIPTION_PROMPT).toContain(NO_SPEECH);
    expect(req.body.messages[1].content[0]).toEqual({
      type: "text",
      text: ENGLISH_TRANSCRIPTION_USER,
    });
    expect(req.body.messages[1].content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: Buffer.from("ID3 fake mp3 bytes").toString("base64"), format: "mp3" },
    });
    // Model and prompt identity are recorded through the provider.
    expect(provider.model).toBe(DEFAULT_TRANSCRIPTION_MODEL);
    expect(provider.name).toBe(`openrouter:${ENGLISH_TRANSCRIPTION_PROMPT_VERSION}`);
    expect(ENGLISH_TRANSCRIPTION_PROMPT_VERSION).toMatch(
      /^english-transcription-v1\+[0-9a-f]{12}$/,
    );
  });

  it("reports no intelligible speech as an empty transcript", async () => {
    for (const content of [NO_SPEECH, "", null]) {
      const { fetch } = endpoint({ content });
      const provider = new OpenRouterTranscriptionProvider({ apiKey: KEY, fetch });
      expect(await provider.transcribe({ path: audio, kind: "audio" }, signal())).toEqual({
        segments: [],
        language: "en",
        complete: true,
      });
    }
  });

  it("retries an empty reply that did not finish normally instead of calling it silence", async () => {
    for (const finish of ["length", "content_filter", "error"]) {
      const { fetch } = endpoint({ content: null, finish });
      const provider = new OpenRouterTranscriptionProvider({ apiKey: KEY, fetch });
      await expect(
        provider.transcribe({ path: audio, kind: "audio" }, signal()),
      ).rejects.toMatchObject({ reason: "provider-failed", retryable: true });
    }
  });

  it("marks a reply cut off by the output cap as incomplete", async () => {
    const { fetch } = endpoint({ content: "Partial words", finish: "length" });
    const provider = new OpenRouterTranscriptionProvider({ apiKey: KEY, fetch });
    expect(await provider.transcribe({ path: audio, kind: "audio" }, signal())).toMatchObject({
      complete: false,
    });
  });

  it("refuses oversized, video and unknown-format input before any request", async () => {
    const { fetch, requests } = endpoint({ content: "x" });
    const small = new OpenRouterTranscriptionProvider({ apiKey: KEY, fetch, maxBytes: 4 });
    await expect(small.transcribe({ path: audio, kind: "audio" }, signal())).rejects.toMatchObject({
      reason: "too-large",
      retryable: false,
    });
    const provider = new OpenRouterTranscriptionProvider({ apiKey: KEY, fetch });
    await expect(
      provider.transcribe({ path: audio, kind: "video" }, signal()),
    ).rejects.toBeInstanceOf(TranscriptionError);
    const odd = join(dir, "clip.xyz");
    await writeFile(odd, "x");
    await expect(provider.transcribe({ path: odd, kind: "audio" }, signal())).rejects.toMatchObject(
      { reason: "provider-failed", retryable: false },
    );
    expect(requests).toHaveLength(0);
  });

  it("retries rate limits and server errors but not bad requests, and never echoes the body", async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [400, false],
    ] as const) {
      const { fetch } = endpoint({ status });
      const provider = new OpenRouterTranscriptionProvider({ apiKey: KEY, fetch });
      const error = await provider
        .transcribe({ path: audio, kind: "audio" }, signal())
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ reason: "provider-failed", retryable });
      expect(String((error as Error).message)).not.toContain("nope");
    }
  });

  it("is selected by STEELE_TRANSCRIPTION_PROVIDER=openrouter with bounded defaults", async () => {
    const adapter = await configuredTranscription({
      STEELE_TRANSCRIPTION_PROVIDER: "openrouter",
      STEELE_TRANSCRIPTION_WORKSPACE: join(dir, "ws"),
      STEELE_TRANSCRIPTION_ALLOWED_HOSTS: "media.test",
      OPENROUTER_API_KEY: KEY,
    });
    expect(adapter).toBeDefined();
    await expect(
      configuredTranscription({
        STEELE_TRANSCRIPTION_PROVIDER: "openrouter",
        STEELE_TRANSCRIPTION_WORKSPACE: join(dir, "ws"),
        STEELE_TRANSCRIPTION_ALLOWED_HOSTS: "media.test",
      }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it("identifies the container from its bytes, as the adapter saves media.audio", async () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]);
    expect(sniffAudioFormat(Buffer.from("ID3\x04rest"))).toBe("mp3");
    expect(sniffAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");
    expect(sniffAudioFormat(Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toBe("aac");
    expect(sniffAudioFormat(wav)).toBe("wav");
    expect(sniffAudioFormat(Buffer.from("OggS\0\0"))).toBe("ogg");
    expect(sniffAudioFormat(Buffer.from("fLaC\0\0"))).toBe("flac");
    expect(sniffAudioFormat(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ")]))).toBe("m4a");
    expect(sniffAudioFormat(Buffer.from("<html>"))).toBeUndefined();
    const media = join(dir, "media.audio");
    await writeFile(media, Buffer.from("ID3 fake mp3 bytes"));
    const { fetch, requests } = endpoint({ content: "Words." });
    const provider = new OpenRouterTranscriptionProvider({ apiKey: KEY, fetch });
    await provider.transcribe({ path: media, kind: "audio" }, signal());
    expect(requests[0]!.body.messages[1].content[1].input_audio.format).toBe("mp3");
  });
});
