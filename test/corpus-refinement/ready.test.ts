import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { syntheticBatch } from "../../src/corpus-refinement/contracts.js";
import { corpusRefinementWorkflow } from "../../src/corpus-refinement/workflow.js";

// A fresh deployment (#856): the repository does not exist until `ready`
// prepares it, and the pinned batch is the run's first write.
let dir: string;
let env: RestateTestEnvironment;
let ingress: clients.Ingress;
let readyCalls = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "corpus-ready-"));
  const repoPath = join(dir, "not-yet-created");
  const artifacts = new GitArtifactStore({ repoPath, repository: "corpus-test" });
  env = await RestateTestEnvironment.start(
    {
      services: [
        corpusRefinementWorkflow({
          artifacts,
          ready: async () => {
            readyCalls++;
            await mkdir(repoPath, { recursive: true });
            await artifacts.initialise();
          },
        }),
      ],
      serviceEndpointAccess: "docker-host",
    },
    () => new RestateContainer("1.8.1"),
  );
  ingress = clients.connect({ url: env.baseUrl() });
}, 240_000);
afterAll(async () => {
  await env?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe(
  "a fresh repository is prepared before the batch is saved (#856)",
  { timeout: 120_000 },
  () => {
    it("runs to completion on a repository that does not exist yet", async () => {
      const wf = ingress.workflowClient<ReturnType<typeof corpusRefinementWorkflow>>(
        { name: "CorpusRefinement" },
        "run-fresh",
      );
      await wf.workflowSubmit(syntheticBatch("run-fresh", 3));
      const out = await wf.workflowAttach();
      expect(out.stages).toHaveLength(3);
      expect(readyCalls).toBe(1);
    });
  },
);
