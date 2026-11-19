import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  CredentialError,
  elasticsearchConnection,
  natsConnection,
  readCredential,
  redact,
  sensitiveValues,
} from "../../src/config/credentials.js";
import { SubstackContentCollector } from "../../src/controllers/substack/collect.js";

/** Synthetic sentinels: never real credentials. */
const TOKEN = "SENTINEL-nats-token-7f3a";
const API_KEY = "SENTINEL-es-key-91bd";
const dir = mkdtempSync(join(tmpdir(), "steele-credentials-"));
const tokenFile = join(dir, "nats_token");
writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o400 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readCredential", () => {
  it("reads a direct value or a mounted file, trimming one trailing newline", () => {
    expect(readCredential("NATS_TOKEN", { env: { NATS_TOKEN: TOKEN } })).toBe(TOKEN);
    expect(readCredential("NATS_TOKEN", { env: { NATS_TOKEN_FILE: tokenFile } })).toBe(TOKEN);
    expect(readCredential("NATS_TOKEN", { env: {} })).toBeUndefined();
  });

  it("fails with sanitised errors that never contain the value or the file path", () => {
    const cases: Array<[NodeJS.ProcessEnv, string]> = [
      [{}, "NATS_TOKEN: missing"],
      [{ NATS_TOKEN_FILE: join(dir, "absent-secret-file") }, "NATS_TOKEN_FILE: unreadable"],
      [{ NATS_TOKEN: TOKEN, NATS_TOKEN_FILE: tokenFile }, "NATS_TOKEN: conflict"],
    ];
    const empty = join(dir, "empty");
    writeFileSync(empty, "\n");
    cases.push([{ NATS_TOKEN_FILE: empty }, "NATS_TOKEN_FILE: empty"]);
    for (const [env, message] of cases) {
      let error: unknown;
      try {
        readCredential("NATS_TOKEN", { env, required: true });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CredentialError);
      const text = `${(error as Error).message} ${(error as Error).stack ?? ""}`;
      expect((error as Error).message).toBe(message);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(dir);
    }
  });

  it("reports an unreadable file without exposing it when permissions deny access", () => {
    if (process.getuid?.() === 0) return; // root can read anything
    const locked = join(dir, "locked");
    writeFileSync(locked, TOKEN);
    chmodSync(locked, 0o000);
    expect(() => readCredential("NATS_TOKEN", { env: { NATS_TOKEN_FILE: locked } })).toThrow(
      "NATS_TOKEN_FILE: unreadable",
    );
  });
});

describe("connection settings", () => {
  it("give each controller only its own credentials", () => {
    const env = {
      NATS_URL: "nats://broker.example:4222",
      NATS_TOKEN: TOKEN,
      ELASTICSEARCH_URL: "https://search.example:9200",
      ELASTICSEARCH_API_KEY: API_KEY,
    };
    expect(natsConnection({ env })).toEqual({ url: "nats://broker.example:4222", token: TOKEN });
    expect(elasticsearchConnection({ env })).toEqual({
      url: "https://search.example:9200",
      apiKey: API_KEY,
    });
    expect(JSON.stringify(natsConnection({ env }))).not.toContain(API_KEY);
    expect(JSON.stringify(elasticsearchConnection({ env }))).not.toContain(TOKEN);
  });

  it("redacts credentials and URL user info from any text", () => {
    const nats = { url: "nats://svc-user:SENTINEL-pass-55@broker.example:4222", token: TOKEN };
    const es = { url: "https://search.example:9200", apiKey: API_KEY };
    const text = `failed ${nats.url} with ${TOKEN} and ${API_KEY} (SENTINEL-pass-55)`;
    const out = redact(text, sensitiveValues(nats, es));
    for (const s of [TOKEN, API_KEY, "SENTINEL-pass-55", "svc-user", "broker.example"]) {
      expect(out).not.toContain(s);
    }
  });
});

describe("entry points", () => {
  const run = (script: string, env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ["--import", "tsx", script], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      encoding: "utf8",
      timeout: 30_000,
    });

  it("print a sanitised setup error for an unreadable mounted secret", () => {
    const r = run("src/cli/provision.ts", {
      NATS_URL: "nats://127.0.0.1:1",
      NATS_TOKEN_FILE: join(dir, "missing-token"),
      ELASTICSEARCH_URL: "http://127.0.0.1:1",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("provision: NATS_TOKEN_FILE: unreadable");
    expect(r.stderr + r.stdout).not.toContain(dir);
  });

  it("never print a credential when the service cannot be reached", () => {
    const r = run("src/cli/provision.ts", {
      NATS_URL: "nats://127.0.0.1:1",
      NATS_TOKEN_FILE: tokenFile,
      ELASTICSEARCH_URL: "http://127.0.0.1:1",
      ELASTICSEARCH_API_KEY: API_KEY,
    });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).not.toContain(TOKEN);
    expect(r.stderr + r.stdout).not.toContain(API_KEY);
    expect(r.stderr + r.stdout).not.toContain(dir);
  }, 40_000);
});

describe("fetched content", () => {
  it("is requested without any credential", async () => {
    process.env.SENTINEL_CHECK = TOKEN; // even if present in the environment
    const requests: Array<{ url: string; headers: string }> = [];
    const collector = new SubstackContentCollector({
      publicationUrl: "https://pub.example.com",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), headers: JSON.stringify(init?.headers ?? {}) });
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
      sleep: async () => {},
    });
    await collector.collect({
      publicationId: "pub",
      postId: "p",
      url: "https://pub.example.com/p/p",
      title: "t",
    });
    delete process.env.SENTINEL_CHECK;
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.url + r.headers).not.toContain(TOKEN);
      expect(r.headers.toLowerCase()).not.toContain("authorization");
    }
  });
});
