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

it("saves source snapshots and gaps and never calls the provider again for a terminal job", async () => {
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
});
