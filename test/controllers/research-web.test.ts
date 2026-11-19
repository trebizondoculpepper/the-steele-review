import { describe, expect, it } from "vite-plus/test";
import { CredentialError } from "../../src/config/credentials.js";
import {
  KagiSearchProvider,
  PublicPageFetcher,
  WebAdapterError,
  kagiFromEnv,
  pageFromHtml,
} from "../../src/controllers/research-web.js";

const KEY = "SENTINEL-kagi-key-77";
const live = () => new AbortController().signal;

async function failure(p: Promise<unknown>): Promise<WebAdapterError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WebAdapterError);
    expect((e as Error).message).not.toContain(KEY);
    return e as WebAdapterError;
  }
  throw new Error("expected failure");
}

describe("KagiSearchProvider", () => {
  const kagi = (respond: () => Response, calls: Array<{ url: string; init: RequestInit }> = []) =>
    new KagiSearchProvider({
      apiKey: KEY,
      limit: 5,
      fetch: (async (url: URL, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return respond();
      }) as typeof fetch,
    });

  it("returns public organic results, deduplicated, with the key only in the header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const body = {
      meta: { api_balance: 4.2 },
      data: [
        { t: 0, url: "https://a.example/x", title: "A" },
        { t: 0, url: "https://a.example/x", title: "dup" },
        { t: 0, url: "http://insecure.example/", title: "http" },
        { t: 0, url: "https://10.0.0.1/", title: "private" },
        { t: 1, list: ["related"] },
        { t: 0, url: "https://b.example/y" },
      ],
    };
    const results = await kagi(() => new Response(JSON.stringify(body)), calls).search(
      "stratospheric aerosol injection",
      live(),
    );
    expect(results).toEqual([
      { url: "https://a.example/x", title: "A" },
      { url: "https://b.example/y", title: "https://b.example/y" },
    ]);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("q")).toBe("stratospheric aerosol injection");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(calls[0].url).not.toContain(KEY);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bot ${KEY}`);
  });

  it("distinguishes credit exhaustion and auth from retryable failures", async () => {
    for (const [status, code, retryable] of [
      [402, "credit-exhausted", true],
      [401, "unauthorised", false],
      [429, "rate-limited", true],
      [502, "unavailable", true],
    ] as const) {
      const e = await failure(kagi(() => new Response(KEY, { status })).search("q", live()));
      expect([e.code, e.retryable]).toEqual([code, retryable]);
    }
    expect((await failure(kagi(() => new Response("nope")).search("q", live()))).code).toBe(
      "bad-response",
    );
  });

  it("is configured through the credentials boundary", () => {
    expect(() => kagiFromEnv({ env: {} })).toThrow(CredentialError);
    expect(kagiFromEnv({ env: { KAGI_API_KEY: KEY } })).toBeInstanceOf(KagiSearchProvider);
  });
});

describe("PublicPageFetcher", () => {
  const html = `<html><head><title>T &amp; Co</title>
    <meta property="og:site_name" content="Example News">
    <meta property="article:published_time" content="2025-03-04T05:06:07Z">
    <script>evil()</script></head>
    <body><nav>menu</nav><p>Aerosols <a href="https://src.example/p">study</a>.</p></body></html>`;
  const fetcher = (responses: Record<string, () => Response>, dns: Record<string, string[]> = {}) =>
    new PublicPageFetcher({
      fetch: async (url: string) => {
        const r = responses[url];
        if (!r) throw new TypeError("no route");
        return r();
      },
      resolve: async (h) => dns[h] ?? ["93.184.216.34"],
    });

  it("extracts readable text and metadata from HTML", async () => {
    const page = await fetcher({
      "https://news.example/a": () =>
        new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    }).fetch("https://news.example/a", live());
    expect(page).toMatchObject({
      url: "https://news.example/a",
      title: "T & Co",
      publisher: "Example News",
      publishedAt: "2025-03-04T05:06:07.000Z",
    });
    expect(page.text).toContain("Aerosols");
    expect(page.text).toContain("https://src.example/p");
    expect(page.text).not.toContain("evil");
    expect(page.text).not.toContain("menu");
  });

  it("refuses redirects and private hosts so cited text comes from the requested URL", async () => {
    const f = fetcher(
      {
        "https://a.example/": () =>
          new Response(null, { status: 302, headers: { location: "https://b.example/" } }),
      },
      { "rebind.example": ["192.168.1.5"], "mixed.example": ["93.184.216.34", "10.0.0.2"] },
    );
    expect((await failure(f.fetch("https://a.example/", live()))).code).toBe("redirected");
    expect((await failure(f.fetch("https://rebind.example/", live()))).code).toBe("not-public");
    expect((await failure(f.fetch("https://mixed.example/", live()))).code).toBe("not-public");
    expect((await failure(f.fetch("https://127.0.0.1/", live()))).code).toBe("not-public");
    expect((await failure(f.fetch("http://a.example/", live()))).code).toBe("not-public");
  });

  it("pins the default transport to addresses validated at connect time", async () => {
    // First resolution (pre-check) is public; the connect-time resolution
    // rebinds to loopback and must be refused before any socket opens.
    let calls = 0;
    const f = new PublicPageFetcher({
      timeoutMs: 5_000,
      resolve: async () => (calls++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]),
    });
    expect((await failure(f.fetch("https://rebinding.example/", live()))).code).toBe("not-public");
    expect(calls).toBe(2);
  });

  it("bounds size and content type", async () => {
    const big = new PublicPageFetcher({
      maxBytes: 10,
      resolve: async () => ["93.184.216.34"],
      fetch: async () =>
        new Response("x".repeat(100), { headers: { "content-type": "text/plain" } }),
    });
    expect((await failure(big.fetch("https://big.example/", live()))).code).toBe("too-large");
    const pdf = fetcher({
      "https://p.example/": () =>
        new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
    });
    expect((await failure(pdf.fetch("https://p.example/", live()))).code).toBe(
      "unsupported-content",
    );
  });

  it("falls back to the URL when a page has no title", () => {
    expect(pageFromHtml("https://x.example/", "<p>hi</p>").title).toBe("https://x.example/");
  });
});
