import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
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
          env: { STEELE_SETTINGS_FILE: "synthetic-settings.json" },
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
