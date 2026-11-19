import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { z } from "zod";
import { readCredential, type CredentialSource } from "../config/credentials.js";
import {
  isPublicHttpsUrl,
  type FetchedPage,
  type PageFetcher,
  type SearchProvider,
  type SearchResult,
} from "../research/gap-research.js";
import { htmlToPlainText } from "./substack/collect.js";

/**
 * Web adapters behind the gap-research ports (#154): a Kagi search provider
 * and a public HTTPS page fetcher.
 *
 * Errors carry a code and retryable flag only, never the key, query, URL or
 * response body. Missing configuration and exhausted credit are distinct
 * codes so callers can leave work pending.
 */

export type WebAdapterErrorCode =
  | "credit-exhausted"
  | "rate-limited"
  | "unauthorised"
  | "unavailable"
  | "bad-response"
  | "too-large"
  | "not-public"
  | "redirected"
  | "unsupported-content"
  | "not-found"
  | "timeout"
  | "cancelled";

// Credit exhaustion is retryable: research must stay pending until credit is
// restored, never be recorded as a permanent failure.
const RETRYABLE = new Set<WebAdapterErrorCode>([
  "credit-exhausted",
  "rate-limited",
  "unavailable",
  "timeout",
]);

export class WebAdapterError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: WebAdapterErrorCode,
    readonly status?: number,
  ) {
    super(`web adapter ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "WebAdapterError";
    this.retryable = RETRYABLE.has(code);
  }
}

function statusCode(status: number): WebAdapterErrorCode {
  if (status === 402) return "credit-exhausted";
  if (status === 401 || status === 403) return "unauthorised";
  if (status === 429) return "rate-limited";
  if (status === 404 || status === 410) return "not-found";
  return status >= 500 ? "unavailable" : "bad-response";
}

function abortCode(signal: AbortSignal, timeout: AbortSignal): WebAdapterError | undefined {
  if (signal.aborted) return new WebAdapterError("cancelled");
  if (timeout.aborted) return new WebAdapterError("timeout");
  return undefined;
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
      throw new WebAdapterError("too-large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// Kagi search

export const DEFAULT_KAGI_SEARCH_URL = "https://kagi.com/api/v0/search";

export interface KagiConfig {
  apiKey: string;
  endpoint?: string;
  /** Results requested per query (1-20). */
  limit?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Called once per successful query, with the remaining API balance when reported. */
  onUsage?: (usage: { queries: 1; balance?: number }) => void;
}

const KagiResponseSchema = z.object({
  meta: z.object({ api_balance: z.number().optional() }).passthrough().optional(),
  data: z.array(
    z
      .object({
        t: z.number(),
        url: z.string().optional(),
        title: z.string().optional(),
      })
      .passthrough(),
  ),
});

/** Kagi's v0 search API: one GET per query, organic results (t = 0) only. */
export class KagiSearchProvider implements SearchProvider {
  private readonly endpoint: URL;
  private readonly limit: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: KagiConfig) {
    if (!config.apiKey) throw new WebAdapterError("unauthorised");
    try {
      this.endpoint = new URL(config.endpoint ?? DEFAULT_KAGI_SEARCH_URL);
    } catch {
      throw new Error("search endpoint is invalid");
    }
    if (this.endpoint.protocol !== "https:") throw new Error("search endpoint must be https");
    this.limit = z
      .number()
      .int()
      .min(1)
      .max(20)
      .parse(config.limit ?? 8);
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.fetchImpl = config.fetch ?? fetch;
  }

  async search(query: string, signal: AbortSignal): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q || q.length > 500) throw new WebAdapterError("bad-response");
    const url = new URL(this.endpoint);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", String(this.limit));
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { authorization: `Bot ${this.config.apiKey}`, accept: "application/json" },
        signal: combined,
        redirect: "error",
      });
    } catch {
      throw abortCode(signal, timeout) ?? new WebAdapterError("unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebAdapterError(statusCode(response.status), response.status);
    }
    let parsed: z.infer<typeof KagiResponseSchema>;
    try {
      parsed = KagiResponseSchema.parse(JSON.parse(await readBounded(response, 2 * 1024 * 1024)));
    } catch (error) {
      if (error instanceof WebAdapterError) throw error;
      throw abortCode(signal, timeout) ?? new WebAdapterError("bad-response");
    }
    const balance = parsed.meta?.api_balance;
    this.config.onUsage?.({ queries: 1, ...(balance !== undefined ? { balance } : {}) });
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const item of parsed.data) {
      if (item.t !== 0 || !item.url || !isPublicHttpsUrl(item.url) || seen.has(item.url)) continue;
      seen.add(item.url);
      results.push({ url: item.url, title: (item.title ?? item.url).slice(0, 500) });
    }
    return results;
  }
}

export function kagiFromEnv(
  source: CredentialSource = {},
  extra: Omit<KagiConfig, "apiKey"> = {},
): KagiSearchProvider {
  return new KagiSearchProvider({
    apiKey: readCredential("KAGI_API_KEY", { ...source, required: true }),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Public page fetcher

export interface PageFetcherConfig {
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Transport override for tests. The default transport resolves the host
   * itself and connects only to the validated public addresses.
   */
  fetch?: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<Response>;
  /** Resolves a hostname to its addresses; injectable for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
  userAgent?: string;
}

const defaultResolve = async (hostname: string) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** True when an IP literal is publicly routable by the same rules as URLs. */
export function isPublicAddress(address: string): boolean {
  const host = isIP(address) === 6 ? `[${address}]` : address;
  return isPublicHttpsUrl(`https://${host}/`);
}

/**
 * GET over node:https whose DNS lookup is the validation itself: the socket
 * can only connect to an address that was checked as public in the same
 * lookup, so a second resolution cannot rebind the host to a private address.
 */
function pinnedTransport(resolve: (hostname: string) => Promise<string[]>) {
  return (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
    new Promise<Response>((resolveResponse, reject) => {
      const pinnedLookup = (
        hostname: string,
        options: { all?: boolean },
        callback: (
          err: Error | null,
          address: string | Array<{ address: string; family: number }>,
          family?: number,
        ) => void,
      ) => {
        resolve(hostname).then(
          (addresses) => {
            const ok = addresses.filter(isPublicAddress);
            if (ok.length === 0 || ok.length !== addresses.length) {
              return callback(new WebAdapterError("not-public"), "", 4);
            }
            const entries = ok.map((address) => ({ address, family: isIP(address) }));
            if (options.all) callback(null, entries);
            else callback(null, entries[0].address, entries[0].family);
          },
          (err: Error) => callback(err, "", 4),
        );
      };
      const req = httpsRequest(url, {
        method: "GET",
        headers: init.headers,
        signal: init.signal,
        lookup: pinnedLookup as never,
      });
      req.on("response", (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers.set(k, v);
          else if (Array.isArray(v)) headers.set(k, v.join(", "));
        }
        const status = res.statusCode ?? 502;
        const body =
          status === 204 || status === 304
            ? null
            : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        resolveResponse(new Response(body, { status, headers }));
      });
      req.on("error", reject);
      req.end();
    });
}

/**
 * Fetch one public HTTPS page as plain text. The URL must be public HTTPS and
 * its host must resolve only to public addresses; the default transport
 * connects to exactly those addresses. Redirects are refused rather than
 * followed: gap research cites the URL it requested, so the text must come
 * from that URL. HTML is converted to text with link destinations kept;
 * plain text is returned as is; anything else is refused.
 */
export class PublicPageFetcher implements PageFetcher {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly resolve: (hostname: string) => Promise<string[]>;
  private readonly transport: NonNullable<PageFetcherConfig["fetch"]>;

  constructor(private readonly config: PageFetcherConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.maxBytes = config.maxBytes ?? 3 * 1024 * 1024;
    this.resolve = config.resolve ?? defaultResolve;
    this.transport = config.fetch ?? pinnedTransport(this.resolve);
  }

  async fetch(url: string, signal: AbortSignal): Promise<FetchedPage> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    await this.assertPublic(url);
    let response: Response;
    try {
      response = await this.transport(url, {
        headers: {
          accept: "text/html,text/plain;q=0.9",
          "user-agent": this.config.userAgent ?? "steele-review-research/1",
        },
        signal: combined,
      });
    } catch (error) {
      if (error instanceof WebAdapterError) throw error;
      throw abortCode(signal, timeout) ?? new WebAdapterError("unavailable");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebAdapterError("redirected", response.status);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebAdapterError(statusCode(response.status), response.status);
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    const html = type.includes("html");
    if (!html && !type.startsWith("text/plain")) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebAdapterError("unsupported-content");
    }
    let body: string;
    try {
      body = await readBounded(response, this.maxBytes);
    } catch (error) {
      if (error instanceof WebAdapterError) throw error;
      throw abortCode(signal, timeout) ?? new WebAdapterError("unavailable");
    }
    return html ? pageFromHtml(url, body) : { url, title: url, text: body };
  }

  private async assertPublic(url: string): Promise<void> {
    if (!isPublicHttpsUrl(url)) throw new WebAdapterError("not-public");
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname)) return; // literal already checked
    let addresses: string[];
    try {
      addresses = await this.resolve(hostname);
    } catch {
      throw new WebAdapterError("unavailable");
    }
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
      throw new WebAdapterError("not-public");
    }
  }
}

const decode = (s: string) => htmlToPlainText(s).replace(/\s+/g, " ").trim();

function meta(html: string, name: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`,
    "i",
  );
  const m = html.match(re);
  const value = m?.[1] ?? m?.[2];
  return value ? decode(value) || undefined : undefined;
}

export function pageFromHtml(url: string, html: string): FetchedPage {
  const title =
    meta(html, "og:title") ?? decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const publisher = meta(html, "og:site_name");
  const published = meta(html, "article:published_time");
  const publishedAt =
    published && !Number.isNaN(Date.parse(published))
      ? new Date(published).toISOString()
      : undefined;
  const bodyHtml = html
    .replace(/<(script|style|noscript|template|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/i, " ");
  return {
    url,
    title: (title || url).slice(0, 500),
    text: htmlToPlainText(bodyHtml),
    ...(publisher ? { publisher: publisher.slice(0, 200) } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}
