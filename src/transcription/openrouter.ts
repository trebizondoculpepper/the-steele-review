import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, isAbsolute } from "node:path";
import { z } from "zod";
import { DEFAULT_OPENROUTER_BASE_URL } from "../controllers/openrouter.js";
import {
  TranscriptionError,
  type MediaKind,
  type ProviderResult,
  type TranscriptionProvider,
} from "./adapter.js";

/**
 * English transcription through OpenRouter (#234).
 *
 * The fallback when Substack supplies no usable transcript: the bounded audio
 * file is sent inline to a configurable low-cost audio-capable model with an
 * explicit English-only instruction (src/prompts/transcription/english.md),
 * so regional English accents are never rendered as another language. A
 * reply of `[NO_SPEECH]`, or nothing, yields no segments, which the adapter
 * reports as `empty-transcript` and the collector records durably as
 * `transcription-unusable`.
 *
 * Bounds: audio only, a maximum file size, a request timeout and an output
 * token cap. Oversized input is refused before any request (`too-large`).
 * Long-episode chunking is a separate increment. The key is sent only in the
 * Authorization header and never logged; errors carry a reason, not a body.
 */

export const DEFAULT_TRANSCRIPTION_MODEL = "google/gemini-3.5-flash-lite";
export const ENGLISH_TRANSCRIPTION_PROMPT = readFileSync(
  new URL("../prompts/transcription/english.md", import.meta.url),
  "utf8",
);
/** The fixed user message that accompanies the audio. */
export const ENGLISH_TRANSCRIPTION_USER = readFileSync(
  new URL("../prompts/transcription/english-user.md", import.meta.url),
  "utf8",
).trim();
/** Identity of both prompt files, recorded with every transcript. */
export const ENGLISH_TRANSCRIPTION_PROMPT_VERSION = `english-transcription-v1+${createHash("sha256")
  .update(JSON.stringify([ENGLISH_TRANSCRIPTION_PROMPT, ENGLISH_TRANSCRIPTION_USER]))
  .digest("hex")
  .slice(0, 12)}`;
export const NO_SPEECH = "[NO_SPEECH]";

/** Audio containers OpenRouter accepts as `input_audio`, by file extension. */
const FORMATS: Record<string, string> = {
  ".mp3": "mp3",
  ".wav": "wav",
  ".m4a": "m4a",
  ".aac": "aac",
  ".ogg": "ogg",
  ".flac": "flac",
};

const Config = z.object({
  apiKey: z.string().min(1),
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/),
  baseUrl: z.url({ protocol: /^https$/ }),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60_000),
  maxOutputTokens: z.number().int().positive().max(200_000),
});

const ResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string().nullable().optional() }),
      }),
    )
    .min(1),
});

export interface OpenRouterTranscriptionConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Inline audio size cap; larger files are refused before any request. */
  maxBytes?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  fetch?: typeof globalThis.fetch;
}

/** Identify an audio container from its leading bytes. */
export function sniffAudioFormat(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length < 4) return undefined;
  if (ascii(0, 3) === "ID3") return "mp3";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(4, 8) === "ftyp") return "m4a";
  if (bytes[0] === 0xff) {
    // MPEG audio frame sync: layer bits 00 mean ADTS (AAC); otherwise MP3.
    if ((bytes[1]! & 0xf6) === 0xf0) return "aac";
    if ((bytes[1]! & 0xe0) === 0xe0) return "mp3";
  }
  return undefined;
}

export class OpenRouterTranscriptionProvider implements TranscriptionProvider {
  readonly name: string;
  readonly model: string;
  private readonly config: z.infer<typeof Config>;
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: OpenRouterTranscriptionConfig) {
    const parsed = Config.safeParse({
      apiKey: options.apiKey,
      model: options.model ?? DEFAULT_TRANSCRIPTION_MODEL,
      baseUrl: options.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
      maxBytes: options.maxBytes ?? 20 * 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 10 * 60_000,
      maxOutputTokens: options.maxOutputTokens ?? 32_000,
    });
    if (!parsed.success) throw new Error("invalid OpenRouter transcription configuration");
    this.config = parsed.data;
    this.model = this.config.model;
    // The prompt identity travels with the provider name into provenance.
    this.name = `openrouter:${ENGLISH_TRANSCRIPTION_PROMPT_VERSION}`;
    this.endpoint = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async transcribe(
    input: { path: string; kind: MediaKind; durationSeconds?: number },
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    signal.throwIfAborted();
    if (!isAbsolute(input.path) || input.kind !== "audio")
      throw new TranscriptionError("provider-failed", false);
    const size = (await stat(input.path)).size;
    if (size > this.config.maxBytes) throw new TranscriptionError("too-large", false);
    const bytes = await readFile(input.path);
    // The adapter stores downloads without an extension (media.audio), so the
    // container is identified from its leading bytes; a known extension is
    // only a fallback.
    const format = sniffAudioFormat(bytes) ?? FORMATS[extname(input.path).toLowerCase()];
    if (!format) throw new TranscriptionError("provider-failed", false);
    const audio = bytes.toString("base64");

    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          max_tokens: this.config.maxOutputTokens,
          messages: [
            { role: "system", content: ENGLISH_TRANSCRIPTION_PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: ENGLISH_TRANSCRIPTION_USER },
                { type: "input_audio", input_audio: { data: audio, format } },
              ],
            },
          ],
        }),
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch {
      if (signal.aborted) throw new TranscriptionError("cancelled", true);
      if (timeout.aborted) throw new TranscriptionError("timeout", true);
      throw new TranscriptionError("provider-failed", true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // Rate limits, credit exhaustion and server errors are worth retrying.
      const retryable =
        response.status === 402 || response.status === 429 || response.status >= 500;
      throw new TranscriptionError("provider-failed", retryable);
    }
    let parsed;
    try {
      parsed = ResponseSchema.parse(await response.json());
    } catch {
      throw new TranscriptionError("provider-failed", true);
    }
    const choice = parsed.choices[0]!;
    const text = (choice.message.content ?? "").trim();
    // Only the explicit sentinel, or an empty reply that finished normally, means
    // no speech; a cut-off, filtered or failed generation is a provider failure.
    if (text === NO_SPEECH || (!text && choice.finish_reason === "stop"))
      return { segments: [], language: "en", complete: true };
    if (!text) throw new TranscriptionError("provider-failed", true);
    return {
      segments: [{ text }],
      language: "en",
      // A reply cut off by the output cap is not a complete transcript.
      complete: choice.finish_reason !== "length",
    };
  }
}
