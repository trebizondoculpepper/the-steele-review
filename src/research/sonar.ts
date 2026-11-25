import { DEFAULT_RESEARCH_MAX_TOKENS } from "../config/settings.js";
import {
  researchTokensFromConfiguration,
  type ResearchTokensReader,
} from "../config/research-tokens.js";
import { z } from "zod";
import { replaySonarDiscovery } from "../controllers/sonar-discovery-replay.js";
import type {
  DiscoveryCapture,
  PartialDiscoveryBody,
} from "./discovery-data.js";
import {
  DEFAULT_RESEARCH_MODEL,
  ResearchModelSchema,
  researchModel,
} from "../config/research-model.js";
import {
  credentialForRequest,
  liveCredential,
  type CredentialProvider,
  type CredentialSource,
} from "../config/credentials.js";
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
export const DEFAULT_SONAR_MAX_OUTPUT_TOKENS = DEFAULT_RESEARCH_MAX_TOKENS;

export interface SonarReport {
  report: string;
  citations: string[];
  /** Valid distinct citations beyond the manifest limit, which are counted rather than dropped silently. */
  omittedCitations?: number;
  model: string;
  costUsd?: number;
}

/**
 * Research reasoning effort (#662). OpenRouter's documented request shape is
 * `reasoning: { effort }`; a model exposes effort selection only when its
 * public metadata lists `reasoning.supported_efforts`. Values follow that doc.
 */
export const ReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/**
 * The recorded mapping of research models to the efforts their route accepts.
 * Absent (or empty) means effort cannot be selected, so a configured effort is
 * refused rather than sent and silently ignored.
 *
 * - perplexity/sonar-deep-research: OpenRouter metadata (GET /api/v1/models,
 *   checked 2026-11-22) shows `reasoning: { mandatory: true }` with no
 *   `supported_efforts`, i.e. "the model does not expose effort selection".
 *   No default effort is documented, so none is claimed.
 */
export const RESEARCH_EFFORT_SUPPORT: Readonly<
  Record<string, readonly ReasoningEffort[]>
> = {
  "perplexity/sonar-deep-research": [],
};

export class ResearchEffortUnsupportedError extends Error {
  constructor(readonly model: string) {
    super(
      `reasoning effort cannot be selected for ${model}: its route does not expose effort selection`,
    );
    this.name = "ResearchEffortUnsupportedError";
  }
}

/** Refuse a configured effort the model's route cannot honour, before any request. */
export function assertResearchEffort(
  model: string,
  effort: ReasoningEffort | undefined,
): void {
  if (effort === undefined) return;
  if (!(RESEARCH_EFFORT_SUPPORT[model] ?? []).includes(effort))
    throw new ResearchEffortUnsupportedError(model);
}

/** `STEELE_RESEARCH_REASONING_EFFORT`, validated; empty or absent means not configured. */
export function researchEffortFromEnv(
  env: Record<string, string | undefined>,
): ReasoningEffort | undefined {
  const raw = env.STEELE_RESEARCH_REASONING_EFFORT;
  if (raw === undefined || raw === "") return undefined;
  const parsed = ReasoningEffortSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `STEELE_RESEARCH_REASONING_EFFORT must be one of ${ReasoningEffortSchema.options.join(", ")}`,
    );
  return parsed.data;
}

export interface SonarClient {
  readonly model: string;
  readonly settings?: {
    model: string;
    timeoutMs: number;
    maxOutputTokens: number;
  };
  readonly liveTokens?: boolean;
  readonly discoveryParameters?: {
    timeoutMs: number;
    maxOutputTokens?: number;
    maxResponseBytes: number;
    /** Present only when an effort is configured (and supported). */
    reasoningEffort?: ReasoningEffort;
  };
  research(
    prompt: { system: string; user: string },
    signal: AbortSignal,
    capture?: DiscoveryCapture,
  ): Promise<SonarReport>;
}

export interface OpenRouterSonarConfig {
  /** A fixed key, or a live provider read once per outbound request (#738). */
  apiKey: string | CredentialProvider;
  model?: string;
  baseUrl?: string;
  /** Required finite limits for a live run. */
  timeoutMs: number;
  maxOutputTokens: number;
  tokens?: ResearchTokensReader;
  maxResponseBytes?: number;
  /** Explicit reasoning effort (#662); refused when the model cannot select it. */
  reasoningEffort?: ReasoningEffort;
  fetch?: typeof fetch;
}

const Limits = z.object({
  timeoutMs: z.number().int().min(1_000).max(900_000),
  maxOutputTokens: z.number().int().min(1).max(32_000),
});

/** http(s) citation URLs in first-seen order, without duplicates. */
export function citationUrls(
  candidates: readonly string[],
  max = 500,
): string[] {
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
    // Fails before any paid request when the route cannot honour the effort.
    assertResearchEffort(this.model, config.reasoningEffort);
    const base = new URL(config.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password) {
      throw new Error(
        "model provider base URL must be https without user info",
      );
    }
    this.endpoint = new URL(base.href);
    this.endpoint.pathname = `${base.pathname.replace(/\/+$/, "")}/chat/completions`;
    this.endpoint.search = "";
    this.endpoint.hash = "";
    this.fetchImpl = config.fetch ?? fetch;
  }

  /** Fixed constructor limits; currentSettings() resolves the live outbound limit. */
  get settings(): {
    model: string;
    timeoutMs: number;
    maxOutputTokens: number;
  } {
    return { model: this.model, ...this.limits };
  }

  get liveTokens(): boolean {
    return !!this.config.tokens;
  }

  async currentSettings() {
    return {
      ...this.settings,
      ...(this.config.tokens ? await this.config.tokens() : {}),
    };
  }

  get discoveryParameters() {
    return {
      timeoutMs: this.limits.timeoutMs,
      ...(this.config.tokens
        ? {}
        : { maxOutputTokens: this.limits.maxOutputTokens }),
      maxResponseBytes: this.config.maxResponseBytes ?? 4 * 1024 * 1024,
      // Part of the discovery identity only when configured: omitted keeps
      // existing identities unchanged.
      ...(this.config.reasoningEffort
        ? { reasoningEffort: this.config.reasoningEffort }
        : {}),
    };
  }

  /** Configured effort, or the provider's own (undocumented, so unknown) default. */
  get reasoning():
    | { configured: ReasoningEffort }
    | { configured: null; providerDefault: "unknown" } {
    return this.config.reasoningEffort
      ? { configured: this.config.reasoningEffort }
      : { configured: null, providerDefault: "unknown" };
  }

  async research(
    prompt: { system: string; user: string },
    signal: AbortSignal,
    capture?: DiscoveryCapture,
  ): Promise<SonarReport> {
    const appliedTokens = this.config.tokens
      ? await this.config.tokens()
      : undefined;
    const timeout = AbortSignal.timeout(this.limits.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const failed = () =>
      signal.aborted
        ? new ModelProviderError("cancelled")
        : timeout.aborted
          ? new ModelProviderError("timeout")
          : new ModelProviderError("unavailable");
    // Read once for this request, outside the transport catch, so a
    // credential problem stays "unauthorised" and nothing is sent (#738).
    const authorization = `Bearer ${credentialForRequest(this.config.apiKey, () => new ModelProviderError("unauthorised"))}`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          max_tokens:
            appliedTokens?.maxOutputTokens ?? this.limits.maxOutputTokens,
          ...(this.config.reasoningEffort
            ? { reasoning: { effort: this.config.reasoningEffort } }
            : {}),
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
      throw new ModelProviderError(
        codeForStatus(response.status),
        response.status,
      );
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
      if (partial)
        await capture?.({
          ...partial,
          ...(appliedTokens ? { appliedTokens } : {}),
        });
      if (error instanceof ModelProviderError) throw error;
      throw failed();
    }
    await capture?.({
      representation: "provider-json",
      body: bytes.toString("base64"),
      encoding: "base64",
      transport: "complete",
      ...(appliedTokens ? { appliedTokens } : {}),
    });
    const replay = replaySonarDiscovery(bytes.toString("utf8"), this.model);
    if (replay.validation !== "valid" || !replay.data)
      throw new ModelProviderError("bad-response");
    const parsed = replay.data;
    const report = parsed.report;
    const all = citationUrls(
      [...parsed.citations, ...parsed.annotationUrls],
      Number.MAX_SAFE_INTEGER,
    );
    const kept = all.slice(0, 500);
    return {
      report,
      citations: kept,
      ...(all.length > kept.length
        ? { omittedCitations: all.length - kept.length }
        : {}),
      model: parsed.model ?? this.model,
      ...(parsed.usage?.costUsd !== undefined
        ? { costUsd: parsed.usage.costUsd }
        : {}),
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
 * STEELE_RESEARCH_MAX_TOKENS (defaults 180 s and 4,000 tokens).
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
    // Read live before each request (#738), never retained from start-up.
    apiKey: liveCredential("OPENROUTER_API_KEY", source),
    model: researchModel(env),
    timeoutMs: num("STEELE_RESEARCH_TIMEOUT_MS", DEFAULT_SONAR_TIMEOUT_MS),
    maxOutputTokens: DEFAULT_SONAR_MAX_OUTPUT_TOKENS,
    tokens: researchTokensFromConfiguration({ env }),
    ...(researchEffortFromEnv(env)
      ? { reasoningEffort: researchEffortFromEnv(env)! }
      : {}),
    ...(env.OPENROUTER_BASE_URL ? { baseUrl: env.OPENROUTER_BASE_URL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
