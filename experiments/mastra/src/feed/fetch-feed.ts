/**
 * Fetch one RSS feed's XML (#943): read-only, bounded and with failure
 * categories that never include the URL or response body.
 */

export const MAX_FEED_BYTES = 5_000_000;

export type FeedFetchFailure = "feed-timeout" | "feed-unavailable" | "feed-too-large" | `feed-http-${number}`;

export class FeedFetchError extends Error {
  constructor(readonly category: FeedFetchFailure) {
    super(category);
    this.name = "FeedFetchError";
  }
}

export async function fetchFeedXml(
  url: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      headers: { accept: "application/rss+xml, application/xml;q=0.9" },
    });
  } catch (error) {
    throw new FeedFetchError(error instanceof Error && error.name === "TimeoutError" ? "feed-timeout" : "feed-unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new FeedFetchError(`feed-http-${response.status}`);
  }
  if (Number(response.headers.get("content-length") ?? 0) > MAX_FEED_BYTES) throw new FeedFetchError("feed-too-large");
  // Enforce the limit while streaming, so a chunked response cannot be buffered without bound.
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = response.body?.getReader();
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FEED_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new FeedFetchError("feed-too-large");
        }
        chunks.push(value);
      }
  } catch (error) {
    if (error instanceof FeedFetchError) throw error;
    throw new FeedFetchError(error instanceof Error && error.name === "TimeoutError" ? "feed-timeout" : "feed-unavailable");
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
