import { readFileSync } from "node:fs";

/**
 * The one bounded writing call (#921), behind a narrow adapter.
 *
 * - `fake` is the default: deterministic, free, and able to simulate
 *   malformed output for tests and control proofs.
 * - `live` calls OpenRouter with the contract's pinned model and parameters.
 *   The key is read from the canonical mounted file on every call and is
 *   never logged, returned or stored. A live call is never retried
 *   automatically: a timeout or lost connection is `provider-uncertain`.
 */

export const LIVE_MODEL = "deepseek/deepseek-v4.1-flash";
export const PARAMETERS = { temperature: 0.2, max_tokens: 2000, response_format: { type: "json_object" } } as const;

export interface ModelResult {
  model: string;
  raw: string;
  usage: { promptTokens: number | null; completionTokens: number | null; costUsd: number | null };
  provider: string | null;
  finishReason: string | null;
}

export class ModelError extends Error {
  readonly code: "provider-uncertain" | "provider-error" | "unauthorised" | "rate-limited";
  constructor(code: ModelError["code"], message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export interface WritingModel {
  readonly mode: "fake" | "live";
  readonly id: string;
  complete(system: string, user: string): Promise<ModelResult>;
}

export class FakeModel implements WritingModel {
  readonly mode = "fake" as const;
  readonly id = "fake/summary-critique-v1";
  private readonly behaviour: "valid" | "malformed" | "partial";
  constructor(behaviour: "valid" | "malformed" | "partial" = "valid") {
    this.behaviour = behaviour;
  }
  async complete(_system: string, user: string): Promise<ModelResult> {
    const title = /Title: (.*)/.exec(user)?.[1]?.slice(0, 60) ?? "the source";
    const article = {
      title: `Fixture review of ${title}`.slice(0, 120),
      summary: `Fixture summary. The source is titled "${title}". This text is produced by the fake model for control proofs and never describes real content.`,
      critique: [
        { point: "Fixture point one.", category: "asserted", why_it_matters: "Fixture reason one." },
        { point: "Fixture point two.", category: "not-checked", why_it_matters: "Fixture reason two." },
        { point: "Fixture point three.", category: "established", why_it_matters: "Fixture reason three." },
      ],
      conclusion: "Fixture conclusion.",
      warnings: ["Produced by the fake model."],
    };
    const raw =
      this.behaviour === "malformed" ? "this is not JSON" : this.behaviour === "partial" ? JSON.stringify({ ...article, critique: [] }) : JSON.stringify(article);
    return { model: this.id, raw, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 }, provider: "fake", finishReason: "stop" };
  }
}

export class OpenRouterModel implements WritingModel {
  readonly mode = "live" as const;
  readonly id = LIVE_MODEL;
  private readonly keyFile: string;
  private readonly fetchImpl: typeof fetch;
  constructor(keyFile: string, fetchImpl: typeof fetch = fetch) {
    this.keyFile = keyFile;
    this.fetchImpl = fetchImpl;
  }
  private key(): string {
    const text = readFileSync(this.keyFile, "utf8");
    // TOML: ignore comments; the last active assignment wins, as a TOML reader would reject duplicates anyway.
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
  async complete(system: string, user: string): Promise<ModelResult> {
    const authorization = `Bearer ${this.key()}`;
    let res: Response;
    try {
      res = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          model: LIVE_MODEL,
          ...PARAMETERS,
          reasoning: { enabled: false },
          usage: { include: true },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
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
      model: body.model ?? LIVE_MODEL,
      raw: body.choices?.[0]?.message?.content ?? "",
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? null,
        completionTokens: body.usage?.completion_tokens ?? null,
        costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : null,
      },
      provider: body.provider ?? null,
      finishReason: body.choices?.[0]?.finish_reason ?? null,
    };
  }
}
