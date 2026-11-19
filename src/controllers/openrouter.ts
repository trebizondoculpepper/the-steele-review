import { z } from "zod";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import { readCredential, type CredentialSource } from "../config/credentials.js";

/**
 * Chat-completion model provider for an OpenAI-compatible endpoint
 * (OpenRouter by default), behind the ExtractionModelProvider port used by
 * every model stage (#153).
 *
 * The API key comes from the credentials boundary and is sent only in the
 * Authorization header to the configured endpoint. Errors carry a code and a
 * retryable flag, never the prompt, response body or key. Credit exhaustion,
 * rate limits and authentication failures are distinguished so callers can
 * leave work pending rather than marking it failed. Provider-reported usage
 * is passed to `onUsage` when present.
 */

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type ModelProviderErrorCode =
  | "credit-exhausted"
  | "rate-limited"
  | "unauthorised"
  | "unavailable"
  | "bad-request"
  | "bad-response"
  | "response-too-large"
  | "timeout"
  | "cancelled";

const RETRYABLE: ReadonlySet<ModelProviderErrorCode> = new Set([
  "rate-limited",
  "unavailable",
  "bad-response",
  "timeout",
]);

export class ModelProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: ModelProviderErrorCode,
    readonly status?: number,
  ) {
    super(`model provider ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "ModelProviderError";
    this.retryable = RETRYABLE.has(code);
  }
}

export interface ModelUsage {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Cost in provider credits (USD on OpenRouter), when reported. */
  cost?: number;
}

export interface OpenRouterConfig {
  apiKey: string;
  /** Provider model name, e.g. "vendor/model". */
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Upper bound on the raw HTTP response body. */
  maxResponseBytes?: number;
  temperature?: number;
  fetch?: typeof fetch;
  onUsage?: (usage: ModelUsage) => void;
}

const ModelName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/-]+$/);

const ResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});

/** Rough characters-per-token bound used to cap output tokens. */
const CHARS_PER_TOKEN = 3;

export class OpenRouterProvider implements ExtractionModelProvider {
  readonly modelVersion: string;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenRouterConfig) {
    if (!config.apiKey) throw new ModelProviderError("unauthorised");
    const model = ModelName.parse(config.model);
    const base = new URL(config.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password) {
      throw new Error("model provider base URL must be https without user info");
    }
    this.endpoint = new URL(`${base.pathname.replace(/\/$/, "")}/chat/completions`, base);
    this.modelVersion = `openrouter/${model}`;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.maxResponseBytes = config.maxResponseBytes ?? 2 * 1024 * 1024;
    this.fetchImpl = config.fetch ?? fetch;
  }

  async complete(
    request: { system: string; user: string; maxOutputChars: number },
    signal: AbortSignal,
  ): Promise<string> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      max_tokens: Math.max(1, Math.ceil(request.maxOutputChars / CHARS_PER_TOKEN)),
      temperature: this.config.temperature ?? 0,
      usage: { include: true },
    };
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: combined,
        redirect: "error",
      });
    } catch {
      throw this.abortError(signal, timeout) ?? new ModelProviderError("unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelProviderError(codeForStatus(response.status), response.status);
    }
    let text: string;
    try {
      text = await readBounded(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      throw this.abortError(signal, timeout) ?? new ModelProviderError("unavailable");
    }
    let parsed: z.infer<typeof ResponseSchema>;
    try {
      parsed = ResponseSchema.parse(JSON.parse(text));
    } catch {
      throw new ModelProviderError("bad-response");
    }
    const content = parsed.choices[0].message.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new ModelProviderError("bad-response");
    }
    if (content.length > request.maxOutputChars) throw new ModelProviderError("response-too-large");
    if (this.config.onUsage) {
      const u = parsed.usage;
      this.config.onUsage({
        model: parsed.model ?? this.config.model,
        ...(u?.prompt_tokens !== undefined ? { promptTokens: u.prompt_tokens } : {}),
        ...(u?.completion_tokens !== undefined ? { completionTokens: u.completion_tokens } : {}),
        ...(u?.cost !== undefined ? { cost: u.cost } : {}),
      });
    }
    return content;
  }

  private abortError(signal: AbortSignal, timeout: AbortSignal): ModelProviderError | undefined {
    if (signal.aborted) return new ModelProviderError("cancelled");
    if (timeout.aborted) return new ModelProviderError("timeout");
    return undefined;
  }
}

export function codeForStatus(status: number): ModelProviderErrorCode {
  if (status === 402) return "credit-exhausted";
  if (status === 401 || status === 403) return "unauthorised";
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "bad-request";
  return "unavailable";
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ModelProviderError("response-too-large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Build a provider from configuration: OPENROUTER_API_KEY (or _FILE),
 * STEELE_MODEL, and optional OPENROUTER_BASE_URL. Throws CredentialError
 * (which names the variable, never the value) when the key is missing.
 */
export function openRouterFromEnv(
  source: CredentialSource = {},
  extra: Pick<OpenRouterConfig, "onUsage" | "fetch" | "timeoutMs"> = {},
): OpenRouterProvider {
  const env = source.env ?? process.env;
  const apiKey = readCredential("OPENROUTER_API_KEY", { ...source, required: true });
  const model = env.STEELE_MODEL;
  if (!model) throw new Error("STEELE_MODEL: missing");
  return new OpenRouterProvider({
    apiKey,
    model,
    ...(env.OPENROUTER_BASE_URL ? { baseUrl: env.OPENROUTER_BASE_URL } : {}),
    ...extra,
  });
}
