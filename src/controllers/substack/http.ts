/**
 * Bounded HTTPS fetching shared by the Substack discovery controllers:
 * destination allowlist checked before every request and redirect hop,
 * per-attempt timeout, caller cancellation, response size limit and bounded
 * retry with backoff. Errors carry sanitised messages only: no URLs, headers
 * or raw client exceptions.
 */

export interface BoundedFetchOptions {
  /** Hostnames that requests and redirects may reach (exact, lower-case). */
  allowedHosts: ReadonlySet<string>;
  timeoutMs: number;
  maxBytes: number;
  /** Total attempts including the first; at least 1. */
  maxAttempts: number;
  maxRedirects: number;
  /** Base backoff delay; doubles per retry. */
  retryDelayMs: number;
  /** Accept header; defaults to RSS/XML. */
  accept?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class DiscoveryFetchError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DiscoveryFetchError";
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Parse a configured URL, throwing a sanitised error that never contains the value. */
export function parseConfiguredUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new DiscoveryFetchError(`${name} is not a valid URL`, false);
  }
}

/** Throw unless the URL is HTTPS to an allowed host. */
export function assertAllowedDestination(url: URL, allowedHosts: ReadonlySet<string>): void {
  if (url.protocol !== "https:") {
    throw new DiscoveryFetchError("destination must use HTTPS", false);
  }
  if (url.username || url.password) {
    throw new DiscoveryFetchError("destination must not contain credentials", false);
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new DiscoveryFetchError("destination host is not allowed", false);
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DiscoveryFetchError("response exceeds size limit", false);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DiscoveryFetchError("response exceeds size limit", false);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

async function fetchOnce(
  start: URL,
  options: BoundedFetchOptions,
  signal: AbortSignal | undefined,
): Promise<string> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = start;
  for (let hop = 0; ; hop++) {
    assertAllowedDestination(url, options.allowedHosts);
    let response: Response;
    try {
      response = await doFetch(url, {
        redirect: "manual",
        signal: combined,
        headers: {
          accept: options.accept ?? "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
        },
      });
    } catch {
      if (signal?.aborted) throw new DiscoveryFetchError("request cancelled", false);
      if (timeout.aborted) throw new DiscoveryFetchError("request timed out", true);
      throw new DiscoveryFetchError("network request failed", true);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new DiscoveryFetchError("redirect without location", false);
      if (hop >= options.maxRedirects) {
        throw new DiscoveryFetchError("too many redirects", false);
      }
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const retryable = response.status === 429 || response.status >= 500;
      throw new DiscoveryFetchError(`unexpected HTTP status ${response.status}`, retryable);
    }
    try {
      return await readBounded(response, options.maxBytes);
    } catch (error) {
      if (error instanceof DiscoveryFetchError) throw error;
      if (signal?.aborted) throw new DiscoveryFetchError("request cancelled", false);
      if (timeout.aborted) throw new DiscoveryFetchError("request timed out", true);
      throw new DiscoveryFetchError("failed reading response", true);
    }
  }
}

/** Fetch a text resource within the configured bounds, retrying transient failures. */
export async function boundedFetchText(
  url: URL,
  options: BoundedFetchOptions,
  signal?: AbortSignal,
): Promise<string> {
  const sleep = options.sleep ?? defaultSleep;
  const attempts = Math.max(1, options.maxAttempts);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(url, options, signal);
    } catch (error) {
      const failure =
        error instanceof DiscoveryFetchError
          ? error
          : new DiscoveryFetchError("request failed", false);
      if (!failure.retryable || attempt >= attempts || signal?.aborted) throw failure;
      try {
        await sleep(options.retryDelayMs * 2 ** (attempt - 1), signal);
      } catch {
        throw new DiscoveryFetchError("request cancelled", false);
      }
    }
  }
}
