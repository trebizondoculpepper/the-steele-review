import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { researchTokensFromConfiguration } from "../../src/config/research-tokens.js";
import { ConfigurationController } from "../../src/controllers/configuration.js";
import { RESEARCH_MAX_TOKENS, RESEARCH_TOKEN_SETTING } from "../../src/config/settings.js";
import { OpenRouterSonarClient } from "../../src/research/sonar.js";
import { sonarFromEnv as subjectProvider } from "../../src/controllers/sonar.js";
import { currentConfigPage } from "../../src/dashboard/config-view.js";
let dir: string, file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "research-tokens-"));
  file = join(dir, "settings.json");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const body = JSON.stringify({
  model: "fixture/model",
  choices: [{ message: { content: "A research report." }, finish_reason: "stop" }],
  citations: [],
});
it("resolves the same typed default, file and environment setting without caching", async () => {
  expect(await researchTokensFromConfiguration({ env: {} })()).toMatchObject({
    maxOutputTokens: 4000,
    source: "default",
  });
  await writeFile(file, JSON.stringify({ [RESEARCH_MAX_TOKENS]: "12000" }));
  const env = { STEELE_SETTINGS_FILE: file };
  const reader = researchTokensFromConfiguration({ env });
  const first = await reader();
  expect(first).toMatchObject({ maxOutputTokens: 12000, source: "file" });
  await writeFile(`${file}.next`, JSON.stringify({ [RESEARCH_MAX_TOKENS]: "16000" }));
  await rename(`${file}.next`, file);
  const next = await reader();
  expect(next).toMatchObject({ maxOutputTokens: 16000, source: "file" });
  expect(next.revision).not.toBe(first.revision);
  expect(
    await researchTokensFromConfiguration({ env: { ...env, [RESEARCH_MAX_TOKENS]: "20000" } })(),
  ).toMatchObject({ maxOutputTokens: 20000, source: "environment" });
  expect(JSON.stringify(next)).not.toContain(file);
});
it.each(["0", "32001", "1.5", "not-a-number"])(
  "refuses invalid current tokens %s without leaking content",
  async (value) => {
    await writeFile(file, JSON.stringify({ [RESEARCH_MAX_TOKENS]: value }));
    await expect(
      researchTokensFromConfiguration({ env: { STEELE_SETTINGS_FILE: file } })(),
    ).rejects.toMatchObject({ category: "invalid-setting" });
  },
);
it("fails closed on configured unreadable/invalid files and retains the old snapshot API unchanged", async () => {
  const c = new ConfigurationController({
    env: {},
    settingsFile: file,
    salt: "public",
    registry: [RESEARCH_TOKEN_SETTING],
    roles: { research: [RESEARCH_MAX_TOKENS] },
  });
  await expect(c.currentSetting("research", RESEARCH_MAX_TOKENS)).rejects.toMatchObject({
    category: "file-missing",
  });
  await writeFile(file, "sensitive malformed sentinel");
  await expect(c.currentSetting("research", RESEARCH_MAX_TOKENS)).rejects.toMatchObject({
    category: "file-invalid",
  });
  await writeFile(file, JSON.stringify({ [RESEARCH_MAX_TOKENS]: "12000" }));
  expect(await c.currentSetting("research", RESEARCH_MAX_TOKENS)).toMatchObject({
    value: 12000,
    source: "file",
  });
  expect(c.activeVersion()).toBeUndefined();
  expect(() => c.runtime("research")).toThrow("not-loaded");
  await expect(c.currentSetting("research", "OPENROUTER_API_KEY")).rejects.toMatchObject({
    category: "not-granted",
  });
});
it("both adapters apply the next live value once per outbound request and capture its non-secret decision", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "synthetic-test-key");
  const requests: number[] = [],
    captures: any[] = [];
  const transport = vi.fn(async (_url, init) => {
    requests.push(JSON.parse(init!.body as string).max_tokens);
    return new Response(body);
  });
  vi.stubGlobal("fetch", transport);
  let raw = JSON.stringify({ [RESEARCH_MAX_TOKENS]: "12000" });
  const read = vi.fn(async () => raw);
  const tokens = researchTokensFromConfiguration({
    env: { STEELE_SETTINGS_FILE: "synthetic-settings.json" },
    read,
  });
  const article = new OpenRouterSonarClient({
    apiKey: "synthetic-test-key",
    model: "fixture/model",
    timeoutMs: 1000,
    maxOutputTokens: 4000,
    tokens,
    fetch: transport,
  });
  const manual = subjectProvider({
    model: "fixture/model",
    timeoutMs: 1000,
    maxTokens: 4000,
    tokens,
  });
  const request = {
    schemaVersion: 1 as const,
    origin: "manual" as const,
    pass: 1,
    subject: "Synthetic subject",
    claims: [],
    corpusRefs: [],
  };
  await article.research(
    { system: "Synthetic prompt", user: "Synthetic data" },
    new AbortController().signal,
    async (value) => {
      captures.push(value);
    },
  );
  raw = JSON.stringify({ [RESEARCH_MAX_TOKENS]: "16000" });
  await manual(request, async (value) => {
    captures.push(value);
  });
  expect(requests).toEqual([12000, 16000]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(captures.map((x) => x.appliedTokens.maxOutputTokens)).toEqual(requests);
  expect(article.discoveryParameters).not.toHaveProperty("maxOutputTokens");
  expect(manual.discoveryProcessor!.parameters).not.toHaveProperty("maxOutputTokens");
  raw = "private malformed sentinel";
  await expect(
    article.research({ system: "", user: "" }, new AbortController().signal),
  ).rejects.toMatchObject({ category: "file-invalid" });
  expect(transport).toHaveBeenCalledTimes(2);
});
it("browser shows effective value and source from the generic file, never credentials or paths", async () => {
  await writeFile(
    file,
    JSON.stringify({ [RESEARCH_MAX_TOKENS]: "12000", OPENROUTER_API_KEY: "SECRET-SENTINEL" }),
  );
  const env = { STEELE_SETTINGS_FILE: file };
  const page = await currentConfigPage(env);
  expect(page).toContain(RESEARCH_MAX_TOKENS);
  expect(page).toContain("12000</td><td>configured</td><td>file");
  expect(page).not.toContain("SECRET-SENTINEL");
  expect(page).not.toContain(dir);
  await writeFile(file, JSON.stringify({ [RESEARCH_MAX_TOKENS]: "13000" }));
  expect(await currentConfigPage(env)).toContain("13000</td>");
});
