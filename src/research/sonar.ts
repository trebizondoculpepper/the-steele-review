import { z } from "zod";
import { readCredential, type CredentialSource } from "../config/credentials.js";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  ModelProviderError,
  codeForStatus,
} from "../controllers/openrouter.js";

/**
 * Sonar Deep Research through OpenRouter (#216).
 *
 * One bounded call per research pass: a finite timeout and output-token cap
 * are always set. The client returns the original report and its structured
 * citations (the generic chat adapter keeps only the text). Errors are
 * `ModelProviderError` codes only — never the key, prompt or response body.
 */

export const DEFAULT_SONAR_MODEL = "perplexity/sonar-deep-research";
export const DEFAULT_SONAR_TIMEOUT_MS = 180_000;
export const DEFAULT_SONAR_MAX_OUTPUT_TOKENS = 4_000;

export interface SonarReport {
  report: string;
  citations: string[];
  /** Valid distinct citations beyond the manifest limit, which are counted rather than dropped silently. */
  omittedCitations?: number;
  model: string;
  costUsd?: number;
}

export interface SonarClient {
  readonly model: string;
  research(prompt: { system: string; user: string }, signal: AbortSignal): Promise<SonarReport>;
}

export interface OpenRouterSonarConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Required finite limits for a live run. */
  timeoutMs: number;
  maxOutputTokens: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

const Limits = z.object({
  timeoutMs: z.number().int().min(1_000).max(900_000),
  maxOutputTokens: z.number().int().min(1).max(32_000),
});

const ResponseSchema = z.object({
  model: z.string().optional(),
  citations: z.array(z.string()).optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          annotations: z
            .array(
              z.looseObject({
                type: z.string().optional(),
                url_citation: z.looseObject({ url: z.string() }).optional(),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ cost: z.number().optional() }).optional(),
});

/** http(s) citation URLs in first-seen order, without duplicates. */
export function citationUrls(candidates: readonly string[], max = 500): string[] {
  const seen = new Set<string>();
  for (const raw of candidates) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (url.username || url.password) continue;
    url.hash = "";
    seen.add(url.href);
    if (seen.size >= max) break;
  }
  return [...seen];
}

export class OpenRouterSonarClient implements SonarClient {
  readonly model: string;
  private readonly endpoint: URL;
  private readonly limits: z.infer<typeof Limits>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenRouterSonarConfig) {
    if (!config.apiKey) throw new ModelProviderError("unauthorised");
    this.limits = Limits.parse({
      timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens,
    });
    this.model = z
      .string()
      .regex(/^[A-Za-z0-9._:/-]{1,200}$/)
      .parse(config.model ?? DEFAULT_SONAR_MODEL);
    const base = new URL(config.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password) {
      throw new Error("model provider base URL must be https without user info");
    }
    this.endpoint = new URL(base.href);
    this.endpoint.pathname = `${base.pathname.replace(/\/+$/, "")}/chat/completions`;
    this.endpoint.search = "";
    this.endpoint.hash = "";
    this.fetchImpl = config.fetch ?? fetch;
  }

  /** Effective non-secret settings, for deployment checks (#317). */
  get settings(): { model: string; timeoutMs: number; maxOutputTokens: number } {
    return { model: this.model, ...this.limits };
  }

  async research(
    prompt: { system: string; user: string },
    signal: AbortSignal,
  ): Promise<SonarReport> {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const failed = () =>
      signal.aborted
        ? new ModelProviderError("cancelled")
        : timeout.aborted
          ? new ModelProviderError("timeout")
          : new ModelProviderError("unavailable");
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          max_tokens: this.limits.maxOutputTokens,
          usage: { include: true },
        }),
        signal: combined,
        redirect: "error",
      });
    } catch {
      throw failed();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelProviderError(codeForStatus(response.status), response.status);
    }
    let text: string;
    try {
      text = await readBounded(response, this.config.maxResponseBytes ?? 4 * 1024 * 1024);
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      throw failed();
    }
    let parsed: z.infer<typeof ResponseSchema>;
    try {
      parsed = ResponseSchema.parse(JSON.parse(text));
    } catch {
      throw new ModelProviderError("bad-response");
    }
    const message = parsed.choices[0].message;
    const report = message.content ?? "";
    if (report.trim().length === 0) throw new ModelProviderError("bad-response");
    const annotated = (message.annotations ?? []).flatMap((a) =>
      a.url_citation ? [a.url_citation.url] : [],
    );
    const all = citationUrls([...(parsed.citations ?? []), ...annotated], Number.MAX_SAFE_INTEGER);
    const kept = all.slice(0, 500);
    return {
      report,
      citations: kept,
      ...(all.length > kept.length ? { omittedCitations: all.length - kept.length } : {}),
      model: parsed.model ?? this.model,
      ...(parsed.usage?.cost !== undefined ? { costUsd: parsed.usage.cost } : {}),
    };
  }
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
 * Configuration: OPENROUTER_API_KEY (or _FILE; the existing credential
 * boundary), STEELE_RESEARCH_MODEL, STEELE_RESEARCH_TIMEOUT_MS and
 * STEELE_RESEARCH_MAX_OUTPUT_TOKENS (defaults 180 s and 4,000 tokens).
 */
export function sonarFromEnv(
  source: CredentialSource = {},
  fetchImpl?: typeof fetch,
): OpenRouterSonarClient {
  const env = source.env ?? process.env;
  const num = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new Error(`${name}: must be an integer`);
    return n;
  };
  return new OpenRouterSonarClient({
    apiKey: readCredential("OPENROUTER_API_KEY", { ...source, required: true }),
    model: env.STEELE_RESEARCH_MODEL || DEFAULT_SONAR_MODEL,
    timeoutMs: num("STEELE_RESEARCH_TIMEOUT_MS", DEFAULT_SONAR_TIMEOUT_MS),
    maxOutputTokens: num("STEELE_RESEARCH_MAX_OUTPUT_TOKENS", DEFAULT_SONAR_MAX_OUTPUT_TOKENS),
    ...(env.OPENROUTER_BASE_URL ? { baseUrl: env.OPENROUTER_BASE_URL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
