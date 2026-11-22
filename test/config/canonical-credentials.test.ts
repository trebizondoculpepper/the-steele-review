import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CredentialError,
  describeSetupError,
  readCredential,
} from "../../src/config/credentials.js";
import { openRouterFromEnv } from "../../src/controllers/openrouter.js";
import { sonarFromEnv } from "../../src/controllers/sonar.js";

const KEY = "SYNTHETIC-selected-credential";
const OTHER = "SYNTHETIC-unrelated-credential";
const dirs: string[] = [];
const fixture = (raw: string) => {
  const dir = mkdtempSync(join(tmpdir(), "steele-canonical-"));
  dirs.push(dir);
  const file = join(dir, "private-config.toml");
  writeFileSync(file, raw, { mode: 0o600 });
  return { dir, file, env: { OPENROUTER_API_KEY_CONFIG_FILE: file } };
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("canonical TOML credential selection", () => {
  it("permits unrelated full-range TOML integers without weakening selected-field validation", () => {
    const { env } = fixture(`OPENROUTER_API_KEY = '${KEY}'\nUNRELATED_ID = 9223372036854775807\n`);
    expect(readCredential("OPENROUTER_API_KEY", { env, required: true })).toBe(KEY);
    const selectedInteger = fixture("OPENROUTER_API_KEY = 9223372036854775807");
    expect(() => readCredential("OPENROUTER_API_KEY", { env: selectedInteger.env })).toThrow(
      "OPENROUTER_API_KEY: invalid",
    );
  });
  it("returns only the selected top-level credential without creating derived files", () => {
    const { dir, env } = fixture(`OPENROUTER_API_KEY = '${KEY}'\nOTHER_SECRET = '${OTHER}'\n`);
    const before = readdirSync(dir);
    expect(readCredential("OPENROUTER_API_KEY", { env, required: true })).toBe(KEY);
    expect(readdirSync(dir)).toEqual(before);
    expect(
      readCredential("OTHER_SECRET", {
        env: { OTHER_SECRET_CONFIG_FILE: env.OPENROUTER_API_KEY_CONFIG_FILE },
      }),
    ).toBe(OTHER);
  });

  it.each([
    ["", "missing"],
    ["OTHER_SECRET = 'unrelated'", "missing"],
    ["OPENROUTER_API_KEY = ''", "empty"],
    ["OPENROUTER_API_KEY = '   '", "empty"],
    ["OPENROUTER_API_KEY = 42", "invalid"],
    ["OPENROUTER_API_KEY = ['wrong']", "invalid"],
    ["[OPENROUTER_API_KEY]\nnested = 'wrong'", "invalid"],
    [`OPENROUTER_API_KEY = '${KEY}'\nOPENROUTER_API_KEY = '${OTHER}'`, "invalid"],
    [`OPENROUTER_API_KEY = '${KEY}`, "invalid"],
    ["#".repeat(1024 * 1024 + 1), "invalid"],
  ])("fails closed without exposing contents or paths (%s)", (raw, category) => {
    const { file, env } = fixture(raw);
    let failure: unknown;
    try {
      readCredential("OPENROUTER_API_KEY", { env, required: true });
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(CredentialError);
    expect(describeSetupError(failure)).toBe(`OPENROUTER_API_KEY: ${category}`);
    const rendered = `${failure}\n${(failure as Error).stack}\n${JSON.stringify(failure)}`;
    for (const sentinel of [KEY, OTHER, file]) expect(rendered).not.toContain(sentinel);
    expect((failure as Error).cause).toBeUndefined();
  });

  it("does not fall back after a missing/unreadable/empty configured source", () => {
    expect(() =>
      readCredential("OPENROUTER_API_KEY", { env: { OPENROUTER_API_KEY_CONFIG_FILE: "" } }),
    ).toThrow("OPENROUTER_API_KEY: empty");
    expect(() =>
      readCredential("OPENROUTER_API_KEY", {
        env: { OPENROUTER_API_KEY_CONFIG_FILE: "/synthetic/missing.toml" },
      }),
    ).toThrow("OPENROUTER_API_KEY: unreadable");
    expect(() =>
      readCredential("OPENROUTER_API_KEY", {
        env: { OPENROUTER_API_KEY_CONFIG_FILE: "synthetic.toml" },
        readFile: () => {
          throw new Error(KEY);
        },
      }),
    ).toThrow("OPENROUTER_API_KEY: unreadable");
  });

  it.each([
    { OPENROUTER_API_KEY: KEY },
    { OPENROUTER_API_KEY: "" },
    { OPENROUTER_API_KEY_FILE: "/synthetic/stale.key" },
    { OPENROUTER_API_KEY_FILE: "" },
  ])("refuses competing authorities before reading either source", (legacy) => {
    const readFile = vi.fn(() => KEY);
    expect(() =>
      readCredential("OPENROUTER_API_KEY", {
        env: { OPENROUTER_API_KEY_CONFIG_FILE: "synthetic.toml", ...legacy },
        readFile,
      }),
    ).toThrow("OPENROUTER_API_KEY: conflict");
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("model adapter startup uses canonical credentials", () => {
  it("sees atomic owner edits on the next request, on an existing adapter too (#738)", async () => {
    const { dir, file, env } = fixture(`OPENROUTER_API_KEY = '${KEY}'`);
    const sent: string[] = [];
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>).authorization);
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
      );
    }) as typeof globalThis.fetch;
    const load = () =>
      openRouterFromEnv({ env: { ...env, STEELE_MODEL: "synthetic/model" } }, { fetch });
    const original = load();
    const replacement = join(dir, "replacement.toml");
    writeFileSync(replacement, `OPENROUTER_API_KEY = '${OTHER}'`);
    renameSync(replacement, file);
    const current = load();
    const request = { system: "synthetic", user: "synthetic", maxOutputChars: 100 };
    await original.complete(request, new AbortController().signal);
    await current.complete(request, new AbortController().signal);
    // The adapter created before the edit no longer keeps a start-up snapshot.
    expect(sent).toEqual([`Bearer ${OTHER}`, `Bearer ${OTHER}`]);
    expect(readdirSync(dir)).toEqual(["private-config.toml"]);
  });

  it("uses the same boundary in standalone research, with no fallback to inherited stale credentials", async () => {
    const { file } = fixture(`OPENROUTER_API_KEY = '${KEY}'`);
    vi.stubEnv("OPENROUTER_API_KEY_CONFIG_FILE", file);
    // Canonical mode requires legacy variables to be absent, including empty overrides.
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    vi.stubEnv("OPENROUTER_API_KEY_FILE", undefined);
    vi.stubEnv("STEELE_RESEARCH_REASONING_EFFORT", undefined);
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
      return new Response(
        JSON.stringify({
          model: "fixture/research",
          choices: [{ finish_reason: "stop", message: { content: "Synthetic report" } }],
          citations: [],
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const provider = sonarFromEnv({ model: "fixture/research", timeoutMs: 1000, maxTokens: 4000 });
    await provider({
      schemaVersion: 1,
      origin: "manual",
      pass: 1,
      subject: "Synthetic",
      claims: [],
      corpusRefs: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.stubEnv("OPENROUTER_API_KEY", "SYNTHETIC-stale");
    expect(() =>
      sonarFromEnv({ model: "fixture/research", timeoutMs: 1000, maxTokens: 4000 }),
    ).toThrow("OPENROUTER_API_KEY: conflict");
    expect(() => openRouterFromEnv()).toThrow("OPENROUTER_API_KEY: conflict");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
