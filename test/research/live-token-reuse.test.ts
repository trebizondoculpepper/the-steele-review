import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { ArtifactStoreError, GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { captureResearchDiscovery } from "../../src/research/discovery.js";
import { RESEARCH_PROMPT_VERSION, runResearchJob } from "../../src/research/runner.js";
import { OpenRouterSonarClient } from "../../src/research/sonar.js";
import { researchTokensFromConfiguration } from "../../src/config/research-tokens.js";
import { researchJobId } from "../../src/research/job.js";
it(
  "normal runner reuses pre-upgrade retained response before live configuration, and audits the next new dispatch",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-token-reuse-"));
    const artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      await artifacts.initialise();
      const request = {
        schemaVersion: 1,
        origin: "manual",
        pass: 1,
        subject: "Synthetic existing subject",
        claims: [],
        corpusRefs: [],
      };
      const response = JSON.stringify({
        model: "fixture/model",
        choices: [{ message: { content: "A retained report." }, finish_reason: "stop" }],
        citations: [],
      });
      const old = await captureResearchDiscovery({
        artifacts,
        operations,
        request,
        owner: "original",
        processor: {
          version: "research-discovery-v1",
          model: "fixture/model",
          promptVersion: RESEARCH_PROMPT_VERSION,
          parameters: { timeoutMs: 1000, maxOutputTokens: 4000, maxResponseBytes: 4 * 1024 * 1024 },
        },
        invoke: async (capture) => {
          await capture(response);
          return {
            report: "A retained report.",
            citations: [],
            annotationUrls: [],
            searchResultUrls: [],
            model: "fixture/model",
            citationProvenance: "provider-original",
          };
        },
      });
      const bytes = await artifacts.read(old.returned);
      const read = vi.fn(async () => JSON.stringify({ STEELE_RESEARCH_MAX_TOKENS: "12000" }));
      const fetch = vi.fn(async (_url, init) => {
        expect(JSON.parse(init!.body as string).max_tokens).toBe(12000);
        return new Response(response);
      });
      const sonar = new OpenRouterSonarClient({
        apiKey: "synthetic-test-key",
        model: "fixture/model",
        timeoutMs: 1000,
        maxOutputTokens: 4000,
        tokens: researchTokensFromConfiguration({
          env: { STEELE_CONFIG_PATH: "synthetic-settings.json" },
          read,
        }),
        fetch,
      });
      const fetcher = {
        fetch: vi.fn(async () => {
          throw new Error("no citations to fetch");
        }),
      };
      const run = await runResearchJob({
        artifacts,
        operations,
        request,
        owner: "resume",
        sonar,
        fetcher,
      });
      expect(run).toMatchObject({ status: "finished", result: { outcome: "complete-with-gaps" } });
      expect(read).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(await artifacts.read(old.returned)).toBe(bytes);
      await runResearchJob({ artifacts, operations, request, owner: "replay", sonar, fetcher });
      expect(read).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      const fresh = { ...request, subject: "Synthetic genuinely new subject" };
      await runResearchJob({ artifacts, operations, request: fresh, owner: "new", sonar, fetcher });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(1);
      const report = JSON.parse(
        await artifacts.read(
          (await artifacts.lookup(`research-jobs/${researchJobId(fresh)}/report.json`))!,
        ),
      );
      const discovery = JSON.parse(
        await artifacts.read({ ...report.discovery, sha256: report.discovery.hash.slice(7) }),
      );
      const returned = JSON.parse(
        await artifacts.read({ ...discovery.returned, sha256: discovery.returned.hash.slice(7) }),
      );
      expect(returned.appliedTokens).toMatchObject({ maxOutputTokens: 12000, source: "file" });
      expect(JSON.stringify(returned.appliedTokens)).not.toContain("synthetic-settings.json");
      expect(fetcher.fetch).not.toHaveBeenCalled();
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each(["configuration", "storage"] as const)(
  "%s failure before dispatch remains retryable, not a paid-response uncertainty",
  { timeout: 60000 },
  async (failure) => {
    const dir = await mkdtemp(join(tmpdir(), "live-token-refusal-"));
    const artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      await artifacts.initialise();
      let raw =
        failure === "configuration"
          ? "sensitive malformed sentinel"
          : JSON.stringify({ STEELE_RESEARCH_MAX_TOKENS: "12000" });
      const request = {
        schemaVersion: 1,
        origin: "manual",
        pass: 1,
        subject: "Synthetic corrected settings",
        claims: [],
        corpusRefs: [],
      };
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "fixture/model",
              choices: [{ message: { content: "A usable report." }, finish_reason: "stop" }],
            }),
          ),
      );
      const sonar = new OpenRouterSonarClient({
        apiKey: "synthetic-test-key",
        model: "fixture/model",
        timeoutMs: 1000,
        maxOutputTokens: 4000,
        tokens: researchTokensFromConfiguration({
          env: { STEELE_CONFIG_PATH: "synthetic-settings.json" },
          read: async () => raw,
        }),
        fetch,
      });
      const deps = {
        artifacts,
        operations,
        request,
        owner: "fixture",
        sonar,
        fetcher: {
          fetch: async () => {
            throw new Error("no citations");
          },
        },
      };
      if (failure === "storage")
        vi.spyOn(artifacts, "list").mockRejectedValueOnce(new ArtifactStoreError("git-failed"));
      await expect(runResearchJob(deps)).rejects.toMatchObject(
        failure === "configuration" ? { category: "file-invalid" } : { code: "git-failed" },
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(
        await artifacts.lookup(`research-jobs/${researchJobId(request)}/result.json`),
      ).toBeUndefined();
      expect(
        (await artifacts.list(`research-discovery/${researchJobId(request)}`, 50)).some((path) =>
          path.endsWith("/uncertain.json"),
        ),
      ).toBe(false);
      raw = JSON.stringify({ STEELE_RESEARCH_MAX_TOKENS: "12000" });
      expect(await runResearchJob(deps)).toMatchObject({
        status: "finished",
        result: { outcome: "complete-with-gaps" },
      });
      await runResearchJob(deps);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each(["local", "staged"] as const)(
  "%s entry point preserves known pre-dispatch configuration refusal and safe retry",
  { timeout: 60000 },
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "live-token-entry-"));
    const artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      await artifacts.initialise();
      vi.stubEnv("OPENROUTER_API_KEY", "synthetic-test-key");
      let raw = "sensitive malformed sentinel";
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "fixture/model",
              choices: [{ message: { content: "A report." }, finish_reason: "stop" }],
            }),
          ),
      );
      vi.stubGlobal("fetch", fetch);
      const tokens = researchTokensFromConfiguration({
        env: { STEELE_CONFIG_PATH: "synthetic-settings.json" },
        read: async () => raw,
      });
      const request = {
        schemaVersion: 1 as const,
        origin: "manual" as const,
        pass: 1,
        subject: `Synthetic ${mode} refusal`,
        claims: [],
        corpusRefs: [],
      };
      const fetcher = {
        fetch: async () => {
          throw new Error("no citations");
        },
      };
      const local = (await import("../../src/controllers/sonar.js")).sonarFromEnv({
        model: "fixture/model",
        timeoutMs: 1000,
        maxTokens: 4000,
        tokens,
      });
      const sonar = new OpenRouterSonarClient({
        apiKey: "synthetic-test-key",
        model: "fixture/model",
        timeoutMs: 1000,
        maxOutputTokens: 4000,
        tokens,
        fetch,
      });
      const run =
        mode === "local"
          ? () =>
              import("../../src/research/sonar-runner.js").then((m) =>
                m.runSonarResearch({
                  artifacts,
                  operations,
                  owner: "fixture",
                  request,
                  fetcher,
                  discover: local,
                }),
              )
          : () =>
              import("../../src/research/staged-research.js").then((m) =>
                m.discoverStage(
                  {
                    artifacts,
                    operations,
                    owner: "fixture",
                    sonar,
                    fetcher,
                    limits: {
                      maxSources: 1,
                      maxAttempts: 1,
                      timeoutMs: 1000,
                      maxSourceChars: 1000,
                    },
                  },
                  request,
                ),
              );
      await expect(run()).rejects.toMatchObject({ category: "file-invalid" });
      expect(fetch).not.toHaveBeenCalled();
      raw = JSON.stringify({ STEELE_RESEARCH_MAX_TOKENS: "12000" });
      await run();
      await run();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        (await artifacts.list(`research-discovery/${researchJobId(request)}`, 50)).some((path) =>
          path.endsWith("/uncertain.json"),
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "local live selection yields archive-failed without terminalizing a job, then retries one genuine dispatch",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-selector-refusal-"));
    const artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      await artifacts.initialise();
      vi.stubEnv("OPENROUTER_API_KEY", "synthetic-test-key");
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "fixture/model",
              choices: [{ message: { content: "A retained-safe report." }, finish_reason: "stop" }],
            }),
          ),
      );
      vi.stubGlobal("fetch", fetch);
      const read = vi.fn(async () => JSON.stringify({ STEELE_RESEARCH_MAX_TOKENS: "12000" }));
      const tokens = researchTokensFromConfiguration({
        env: { STEELE_CONFIG_PATH: "synthetic-settings.json" },
        read,
      });
      const local = (await import("../../src/controllers/sonar.js")).sonarFromEnv({
        model: "fixture/model",
        timeoutMs: 1000,
        maxTokens: 4000,
        tokens,
      });
      const request = {
        schemaVersion: 1 as const,
        origin: "manual" as const,
        pass: 1,
        subject: "Synthetic selector retry",
        claims: [],
        corpusRefs: [],
      };
      const { runSonarResearch } = await import("../../src/research/sonar-runner.js");
      const run = () =>
        runSonarResearch({
          artifacts,
          operations,
          owner: "fixture",
          request,
          discover: local,
          fetcher: {
            fetch: async () => {
              throw new Error("no source retrieval expected");
            },
          },
        });
      const scan = vi
        .spyOn(artifacts, "list")
        .mockResolvedValueOnce(Array.from({ length: 201 }, (_, index) => `synthetic-${index}`));
      await expect(run()).rejects.toMatchObject({ code: "archive-failed" });
      expect(operations.operationStatus(`research:${researchJobId(request)}`)).toBeUndefined();
      expect(operations.operationStatus(`research-run:${researchJobId(request)}`)?.status).toBe(
        "released",
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      scan.mockRestore();
      expect((await run()).status).toBe("finished");
      await run();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
