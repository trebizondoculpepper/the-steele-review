import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openRouterFromEnv } from "../../src/controllers/openrouter.js";
import { sonarFromEnv as subjectSonarFromEnv } from "../../src/controllers/sonar.js";
import { sonarFromEnv } from "../../src/research/sonar.js";

// Synthetic credentials only (#738).
const KEY_A = "sk-or-SYNTHETIC-key-alpha";
const KEY_B = "sk-or-SYNTHETIC-key-bravo";
const KEY_C = "sk-or-SYNTHETIC-key-charlie";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-live-cred-"));
  file = join(dir, "openrouter.toml");
  await replace(KEY_A);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** Atomic canonical-file replacement: write a temporary file, then rename. */
async function replace(key: string) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `OPENROUTER_API_KEY = "${key}"\n`);
  await rename(tmp, file);
}

function capture(body: unknown) {
  const auth: string[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    auth.push(String((init?.headers as Record<string, string>).authorization));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { auth, fetch };
}

const completion = {
  model: "vendor/model",
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
};
const req = { system: "s", user: "u", maxOutputChars: 100 };
const leaks = (text: string) => [KEY_A, KEY_B, KEY_C, dir].some((secret) => text.includes(secret));

describe("live model credentials (#738)", () => {
  it("OpenRouter: the same adapter uses each atomically replaced key on its next request", async () => {
    const t = capture(completion);
    const env = { OPENROUTER_API_KEY_CONFIG_FILE: file, STEELE_MODEL: "vendor/model" };
    const p = openRouterFromEnv({ env }, { fetch: t.fetch });
    const signal = new AbortController().signal;
    await p.complete(req, signal);
    await replace(KEY_B);
    await p.complete(req, signal);
    await replace(KEY_C);
    await p.complete(req, signal);
    expect(t.auth).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`, `Bearer ${KEY_C}`]);
  });

  it("OpenRouter: invalid, deleted or conflicting configuration sends nothing and leaks nothing", async () => {
    const t = capture(completion);
    const env: Record<string, string> = {
      OPENROUTER_API_KEY_CONFIG_FILE: file,
      STEELE_MODEL: "vendor/model",
    };
    const p = openRouterFromEnv({ env }, { fetch: t.fetch });
    const signal = new AbortController().signal;
    const refused = async () => {
      const error = await p.complete(req, signal).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(Error);
      // A credential problem is unauthorised, never a retryable transport failure.
      expect(error!.message).toMatch(/unauthorised/);
      expect(leaks(`${error!.message} ${error!.stack ?? ""}`)).toBe(false);
    };
    await writeFile(file, "OPENROUTER_API_KEY = [not toml");
    await refused();
    await rm(file);
    await refused();
    await replace(KEY_B);
    env.OPENROUTER_API_KEY = KEY_C; // a second authority is a conflict
    await refused();
    // Never a silent fallback to the key read at start-up.
    expect(t.auth).toEqual([]);
    delete env.OPENROUTER_API_KEY;
    await p.complete(req, signal);
    expect(t.auth).toEqual([`Bearer ${KEY_B}`]);
  });

  it("still fails at start-up when the key is not configured", () => {
    expect(() =>
      openRouterFromEnv({ env: { STEELE_MODEL: "vendor/model" } }, { fetch: capture({}).fetch }),
    ).toThrow(/OPENROUTER_API_KEY: missing/);
  });

  it("research client: the same adapter reads the current key per request", async () => {
    const t = capture({
      model: "perplexity/sonar-deep-research",
      choices: [{ message: { content: "# Report" }, finish_reason: "stop" }],
      citations: [],
    });
    const client = sonarFromEnv({ env: { OPENROUTER_API_KEY_CONFIG_FILE: file } }, t.fetch);
    const signal = new AbortController().signal;
    await client.research({ system: "s", user: "u" }, signal).catch(() => undefined);
    await replace(KEY_B);
    await client.research({ system: "s", user: "u" }, signal).catch(() => undefined);
    expect(t.auth).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    await rm(file);
    const error = await client.research({ system: "s", user: "u" }, signal).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error?.message)).toMatch(/unauthorised/);
    expect(leaks(String(error?.message))).toBe(false);
    expect(t.auth).toHaveLength(2);
  });

  it("standalone subject researcher: reads the current key per request", async () => {
    const t = capture({ choices: [] });
    vi.stubGlobal("fetch", t.fetch);
    vi.stubEnv("OPENROUTER_API_KEY_CONFIG_FILE", file);
    vi.stubEnv("OPENROUTER_API_KEY", undefined as unknown as string);
    vi.stubEnv("OPENROUTER_API_KEY_FILE", undefined as unknown as string);
    vi.stubEnv("STEELE_RESEARCH_REASONING_EFFORT", "");
    const run = subjectSonarFromEnv({
      model: "perplexity/sonar-deep-research",
      timeoutMs: 10_000,
      maxTokens: 100,
    });
    const request = {
      schemaVersion: 1,
      origin: "manual",
      subject: "s",
      pass: 1,
      claims: [],
      corpusRefs: [],
    } as never;
    await run(request).catch(() => undefined);
    await replace(KEY_B);
    await run(request).catch(() => undefined);
    expect(t.auth).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    await rm(file);
    const error = await run(request).catch((e) => e);
    expect(String(error?.code ?? error?.message)).toMatch(/unauthorised/);
    expect(leaks(String(error?.message))).toBe(false);
    expect(t.auth).toHaveLength(2);
  });
});
