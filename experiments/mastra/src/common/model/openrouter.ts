import { readFileSync } from "node:fs";

/**
 * The shared OpenRouter model boundary (#953).
 *
 * Every model call in the pilot goes through here. The credential is the
 * canonical mounted key file (STEELE_EXP_MASTRA_MODEL_KEY_FILE, a TOML file
 * with one OPENROUTER_API_KEY), read on each call and never copied, logged or
 * returned. Errors are categories only; provider messages are never surfaced.
 */

export type ModelErrorCode = "unauthorised" | "rate-limited" | "provider-error" | "provider-uncertain";

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ModelError";
  }
}

/** The key from the canonical TOML key file; exactly one active OPENROUTER_API_KEY. */
export function readOpenRouterKey(keyFile: string): string {
  let text: string;
  try {
    text = readFileSync(keyFile, "utf8");
  } catch {
    throw new ModelError("unauthorised", "model key unavailable");
  }
  const active = text
    .split("\n")
    .map((l) => l.replace(/^\s+/, ""))
    .filter((l) => !l.startsWith("#"))
    .map((l) => /^OPENROUTER_API_KEY\s*=\s*"([^"]+)"\s*(#.*)?$/.exec(l)?.[1] ?? /^OPENROUTER_API_KEY\s*=\s*'([^']+)'\s*(#.*)?$/.exec(l)?.[1])
    .filter((v): v is string => Boolean(v));
  if (active.length !== 1) throw new ModelError("unauthorised", "model key unavailable");
  const key = active[0]!;
  if (!/^[A-Za-z0-9._-]{20,200}$/.test(key)) throw new ModelError("unauthorised", "model key unavailable");
  return key;
}

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  json?: boolean;
  timeoutMs?: number;
}

export interface ChatResult {
  model: string;
  raw: string;
  provider: string | null;
  finishReason: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null; costUsd: number | null };
}

/** A chat-completion client; tests supply their own. */
export interface ChatModel {
  complete(request: ChatRequest): Promise<ChatResult>;
}

export class OpenRouterChat implements ChatModel {
  constructor(
    private readonly keyFile: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(request: ChatRequest): Promise<ChatResult> {
    const authorization = `Bearer ${readOpenRouterKey(this.keyFile)}`;
    let res: Response;
    try {
      res = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(request.timeoutMs ?? 120_000),
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxTokens,
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
          reasoning: { enabled: false },
          usage: { include: true },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
        }),
      });
    } catch {
      // The request may have been accepted and charged: never retried automatically.
      throw new ModelError("provider-uncertain", "no response from the model provider");
    }
    if (res.status === 401 || res.status === 403) throw new ModelError("unauthorised", `provider returned ${res.status}`);
    if (res.status === 429) throw new ModelError("rate-limited", "provider rate limit");
    if (!res.ok) throw new ModelError("provider-error", `provider returned ${res.status}`);
    let body: {
      model?: string;
      provider?: string;
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    try {
      body = await res.json();
    } catch {
      throw new ModelError("provider-uncertain", "unreadable provider response");
    }
    return {
      model: body.model ?? request.model,
      raw: body.choices?.[0]?.message?.content ?? "",
      provider: body.provider ?? null,
      finishReason: body.choices?.[0]?.finish_reason ?? null,
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? null,
        completionTokens: body.usage?.completion_tokens ?? null,
        costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : null,
      },
    };
  }
}
