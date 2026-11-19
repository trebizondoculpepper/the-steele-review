import { describe, expect, it } from "vite-plus/test";
import { ClaimExtractor } from "../../src/analysis/extraction.js";
import { CredentialError } from "../../src/config/credentials.js";
import {
  ModelProviderError,
  OpenRouterProvider,
  codeForStatus,
  openRouterFromEnv,
  type ModelUsage,
} from "../../src/controllers/openrouter.js";

const KEY = "SENTINEL-openrouter-key-42";
const req = { system: "sys", user: "usr", maxOutputChars: 1000 };
const ok = (content: string, extra: object = {}) =>
  new Response(
    JSON.stringify({
      model: "vendor/m",
      choices: [{ message: { content }, finish_reason: "stop" }],
      ...extra,
    }),
    { status: 200 },
  );

function provider(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const usage: ModelUsage[] = [];
  const p = new OpenRouterProvider({
    apiKey: KEY,
    model: "vendor/m",
    fetch: (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond(String(url), init);
    }) as typeof fetch,
    onUsage: (u) => usage.push(u),
  });
  return { p, calls, usage };
}

async function failure(promise: Promise<unknown>): Promise<ModelProviderError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ModelProviderError);
    expect(String((e as Error).message)).not.toContain(KEY);
    return e as ModelProviderError;
  }
  throw new Error("expected failure");
}

describe("OpenRouterProvider", () => {
  it("sends one bounded chat request and returns the content with usage", async () => {
    const { p, calls, usage } = provider(() =>
      ok('{"claims":[]}', { usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0001 } }),
    );
    expect(p.modelVersion).toBe("openrouter/vendor/m");
    expect(await p.complete(req, new AbortController().signal)).toBe('{"claims":[]}');
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
    expect(body.max_tokens).toBe(Math.ceil(1000 / 3));
    await p
      .complete({ ...req, maxOutputChars: 200_000 }, new AbortController().signal)
      .catch(() => undefined);
    expect(JSON.parse(String(calls[1].init.body)).max_tokens).toBe(8192);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(usage.slice(0, 1)).toEqual([
      { model: "vendor/m", promptTokens: 10, completionTokens: 3, cost: 0.0001 },
    ]);
  });

  it("maps HTTP failures to distinct codes, with credit exhaustion kept resumable", async () => {
    expect(codeForStatus(402)).toBe("credit-exhausted");
    expect(codeForStatus(401)).toBe("unauthorised");
    expect(codeForStatus(429)).toBe("rate-limited");
    expect(codeForStatus(503)).toBe("unavailable");
    for (const [status, code, retryable] of [
      [402, "credit-exhausted", true],
      [429, "rate-limited", true],
      [500, "unavailable", true],
    ] as const) {
      const { p } = provider(() => new Response(`leak ${KEY}`, { status }));
      const e = await failure(p.complete(req, new AbortController().signal));
      expect([e.code, e.retryable]).toEqual([code, retryable]);
    }
  });

  it("rejects malformed, empty and oversized responses", async () => {
    for (const r of [
      () => new Response("not json", { status: 200 }),
      () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      () => ok(""),
    ]) {
      const { p } = provider(r);
      expect((await failure(p.complete(req, new AbortController().signal))).code).toBe(
        "bad-response",
      );
    }
    const { p } = provider(() => ok("x".repeat(2000)));
    expect((await failure(p.complete(req, new AbortController().signal))).code).toBe(
      "response-too-large",
    );
  });

  it("reports cancellation and network failure without leaking", async () => {
    const ac = new AbortController();
    ac.abort();
    const { p } = provider((_u, init) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      throw new TypeError("network");
    });
    expect((await failure(p.complete(req, ac.signal))).code).toBe("cancelled");
    expect((await failure(p.complete(req, new AbortController().signal))).code).toBe("unavailable");
  });

  it("refuses a malformed base URL without echoing it", () => {
    expect(
      () => new OpenRouterProvider({ apiKey: KEY, model: "m", baseUrl: `https://u:${KEY}@[bad` }),
    ).toThrow(/^model provider base URL is invalid$/);
  });

  it("keeps the configured origin for a base path beginning with //", async () => {
    const calls: string[] = [];
    const p = new OpenRouterProvider({
      apiKey: KEY,
      model: "m",
      baseUrl: "https://api.example//evil.example/v1",
      fetch: (async (url: URL) => {
        calls.push(String(url));
        return ok("x");
      }) as typeof fetch,
    });
    await p.complete(req, new AbortController().signal);
    expect(new URL(calls[0]).host).toBe("api.example");
  });

  it("refuses a non-https base URL", () => {
    expect(
      () => new OpenRouterProvider({ apiKey: KEY, model: "m", baseUrl: "http://x.example/v1" }),
    ).toThrow();
  });

  it("is configured through the credentials boundary", () => {
    expect(() => openRouterFromEnv({ env: { STEELE_MODEL: "m" } })).toThrow(CredentialError);
    const p = openRouterFromEnv({ env: { OPENROUTER_API_KEY: KEY, STEELE_MODEL: "vendor/m" } });
    expect(p.modelVersion).toBe("openrouter/vendor/m");
  });

  it("plugs into an existing model stage", async () => {
    const { p } = provider(() => ok('{"claims":[]}'));
    const extractor = new ClaimExtractor({ provider: p });
    const result = await extractor.extract({
      text: "Nothing here.",
      artifact: {
        repository: "r",
        commit: "a".repeat(40),
        path: "p",
        sha256: "b".repeat(64),
      },
    } as never);
    expect(result.status).not.toBe("failed");
  });
});
