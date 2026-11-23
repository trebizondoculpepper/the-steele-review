import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { WebAdapterError } from "../../src/controllers/research-web.js";
import { SonarError } from "../../src/controllers/sonar.js";
import { ResearchRequestSchema } from "../../src/research/job.js";
import { runSonarResearch } from "../../src/research/sonar-runner.js";

it(
  "saves source snapshots and gaps and never calls the provider again for a terminal job",
  { timeout: 60_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-sonar-"));
    const artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      await artifacts.initialise();
      const request = ResearchRequestSchema.parse({
        schemaVersion: 1,
        origin: "manual",
        pass: 1,
        subject: "Test treaty",
        claims: [],
        corpusRefs: [],
      });
      const discover = vi
        .fn()
        .mockResolvedValueOnce({
          model: "fixture",
          report: "# Treaty",
          citations: [
            "https://example.org/treaty",
            "https://example.org/treaty.pdf",
            "https://example.org/bad-status",
          ],
        })
        .mockRejectedValueOnce(new SonarError("timeout"));
      const fetcher = {
        fetch: vi
          .fn()
          .mockResolvedValueOnce({
            url: "https://example.org/treaty",
            title: "Treaty",
            text: "Article I",
            original: { contentType: "text/html", body: "<p>Article I</p>" },
          })
          .mockRejectedValueOnce(new WebAdapterError("unsupported-content"))
          .mockRejectedValueOnce(new WebAdapterError("bad-response")),
      };
      const config = { artifacts, operations, owner: "owner", request, discover, fetcher };
      const run = await runSonarResearch(config);
      if (run.status !== "finished" || !run.result.manifest) throw new Error("no manifest");
      expect(run.result.outcome).toBe("complete-with-gaps");
      const path = `research-jobs/${run.result.jobId}`;
      const snapshot = await artifacts.lookup(`${path}/sources/1.json`);
      if (!snapshot) throw new Error("no snapshot");
      expect(JSON.parse(await artifacts.read(snapshot)).original.body).toBe("<p>Article I</p>");
      const manifestRef = await artifacts.lookup(`${path}/manifest.json`);
      const reportRef = await artifacts.lookup(`${path}/report.md`);
      expect(reportRef).toBeDefined();
      expect(JSON.parse(await artifacts.read(manifestRef!)).citations[2]).toMatchObject({
        retrieval: "inaccessible",
        confidenceRationale: "bad-response",
      });
      expect(operations.pendingEventStatus(run.result.jobId)).toBe("pending");
      await expect(runSonarResearch(config)).resolves.toMatchObject({ reused: true });
      const other = { ...config, request: { ...request, subject: "Different subject" } };
      await expect(runSonarResearch(other)).resolves.toMatchObject({
        result: { outcome: "failed", failure: "timeout" },
      });
      await expect(runSonarResearch(other)).resolves.toMatchObject({ reused: true });
      expect(discover).toHaveBeenCalledTimes(2);
      expect(fetcher.fetch).toHaveBeenCalledTimes(3);
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "keeps definite manual-adapter rejection metadata distinct from uncertain transport failures",
  { timeout: 60_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-subject-rejection-")),
      artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" }),
      operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      await artifacts.initialise();
      for (const [code, status, expected] of [
        ["rate-limited", 429, "rate-limited"],
        ["unauthorised", 401, "unauthorised"],
        ["bad-request", 400, "bad-request"],
      ] as const) {
        const request = ResearchRequestSchema.parse({
          schemaVersion: 1,
          origin: "manual",
          pass: 1,
          subject: `Synthetic rejection ${status}`,
          claims: [],
          corpusRefs: [],
        });
        const result = await runSonarResearch({
          artifacts,
          operations,
          owner: "fixture",
          request,
          discover: async () => {
            throw new SonarError(code, status);
          },
          fetcher: {
            fetch: async () => {
              throw new Error("must not fetch");
            },
          },
        });
        if (result.status !== "finished") throw new Error("not finished");
        const names = await artifacts.list(`research-discovery/${result.result.jobId}`, 50),
          failure = names.find((p) => p.endsWith("/failure.json"));
        expect(failure).toBeDefined();
        const saved = await artifacts.lookup(failure!);
        expect(JSON.parse(await artifacts.read(saved!))).toMatchObject({
          code: expected,
          status,
          definiteRejection: true,
        });
        expect(names.some((p) => p.endsWith("/uncertain.json"))).toBe(false);
      }
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it(
  "local subject research retains a readable output-limited report, annotations and warning without rediscovery",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-sonar-partial-"));
    const artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
    const operations = new OperationStore({ path: join(dir, "state.sqlite") });
    try {
      await artifacts.initialise();
      const request = ResearchRequestSchema.parse({
        schemaVersion: 1,
        origin: "manual",
        pass: 1,
        subject: "Synthetic history",
        claims: [],
        corpusRefs: [],
      });
      const raw = JSON.stringify({
        model: "fixture/model",
        choices: [
          {
            message: {
              content: "A useful partial public history.",
              annotations: [{ url_citation: { url: "https://source.example/history" } }],
            },
            finish_reason: "length",
          },
        ],
      });
      const discover = vi.fn(async (_request, capture) => {
        await capture!({
          representation: "provider-json",
          body: Buffer.from(raw).toString("base64"),
          encoding: "base64",
          transport: "complete",
        });
        throw new SonarError("invalid-report");
      });
      const fetcher = {
        fetch: vi.fn(async (url: string) => ({
          url,
          title: "History",
          text: "Independent source text.",
        })),
      };
      const config = { artifacts, operations, owner: "fixture", request, discover, fetcher };
      const out = await runSonarResearch(config);
      expect(out).toMatchObject({
        status: "finished",
        result: { outcome: "complete-with-gaps", warnings: [{ code: "report-output-limit" }] },
      });
      if (out.status !== "finished") throw new Error("unexpected busy");
      const manifest = JSON.parse(
        await artifacts.read({
          ...out.result.manifest!,
          sha256: out.result.manifest!.hash.slice(7),
        }),
      );
      expect(manifest.citations[0].url).toBe("https://source.example/history");
      expect(
        await artifacts.read({ ...manifest.report, sha256: manifest.report.hash.slice(7) }),
      ).toContain("A useful partial public history.");
      await runSonarResearch(config);
      expect(discover).toHaveBeenCalledTimes(1);
      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    } finally {
      operations.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
