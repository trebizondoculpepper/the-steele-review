import { z } from "zod";
import type { DiscoveryCapture, PartialDiscoveryBody } from "./discovery-data.js";
import {
  DEFAULT_RESEARCH_MODEL,
  ResearchModelSchema,
  researchModel,
} from "../config/research-model.js";
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

export const DEFAULT_SONAR_MODEL = DEFAULT_RESEARCH_MODEL;
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
  readonly settings?: { model: string; timeoutMs: number; maxOutputTokens: number };
  readonly discoveryParameters?: {
    timeoutMs: number;
    maxOutputTokens: number;
    maxResponseBytes: number;
  };
  research(
    prompt: { system: string; user: string },
    signal: AbortSignal,
    capture?: DiscoveryCapture,
  ): Promise<SonarReport>;
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
  usage: z
    .object({
      cost: z.number().nonnegative().optional(),
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
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
    this.model = ResearchModelSchema.parse(config.model ?? DEFAULT_SONAR_MODEL);
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

  get discoveryParameters() {
    return { ...this.limits, maxResponseBytes: this.config.maxResponseBytes ?? 4 * 1024 * 1024 };
  }

  async research(
    prompt: { system: string; user: string },
    signal: AbortSignal,
    capture?: DiscoveryCapture,
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
    let bytes: Buffer;
    let partial: PartialDiscoveryBody | undefined;
    try {
      bytes = await readBounded(
        response,
        this.config.maxResponseBytes ?? 4 * 1024 * 1024,
        (value) => {
          partial = value;
        },
      );
    } catch (error) {
      if (partial) await capture?.(partial);
      if (error instanceof ModelProviderError) throw error;
      throw failed();
    }
    await capture?.({
      representation: "provider-json",
      body: bytes.toString("base64"),
      encoding: "base64",
      transport: "complete",
    });
    const text = bytes.toString("utf8");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ModelProviderError("bad-response");
    }
    let parsed: z.infer<typeof ResponseSchema>;
    try {
      parsed = ResponseSchema.parse(payload);
    } catch {
      throw new ModelProviderError("bad-response");
    }
    const message = parsed.choices[0].message;
    const report = message.content ?? "";
    const annotated = (message.annotations ?? []).flatMap((a) =>
      a.url_citation ? [a.url_citation.url] : [],
    );
    if (report.trim().length === 0) throw new ModelProviderError("bad-response");
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

async function readBounded(
  response: Response,
  maxBytes: number,
  onPartial: (value: PartialDiscoveryBody) => void,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0,
    limited = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        limited = true;
        await reader.cancel().catch(() => undefined);
        throw new ModelProviderError("response-too-large");
      }
    }
  } catch (error) {
    if (total)
      onPartial({
        representation: "provider-json",
        body: Buffer.concat(chunks).subarray(0, maxBytes).toString("base64"),
        encoding: "base64",
        transport: limited ? "resource-limit" : "incomplete",
      });
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
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
    model: researchModel(env),
    timeoutMs: num("STEELE_RESEARCH_TIMEOUT_MS", DEFAULT_SONAR_TIMEOUT_MS),
    maxOutputTokens: num("STEELE_RESEARCH_MAX_OUTPUT_TOKENS", DEFAULT_SONAR_MAX_OUTPUT_TOKENS),
    ...(env.OPENROUTER_BASE_URL ? { baseUrl: env.OPENROUTER_BASE_URL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
