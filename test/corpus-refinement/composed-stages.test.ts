import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  corpusRefinementPath,
  type CorpusRefinementInput,
  type IdeasResult,
  type UnderlyingResult,
} from "../../src/corpus-refinement/contracts.js";
import { corpusRefinementWorkflow } from "../../src/corpus-refinement/workflow.js";
import { CATALOGUE_PATH, SEED_CATALOGUE } from "../../src/corpus-refinement/catalogue.js";

// Deterministic fixtures and a fake provider only: no paid calls (#837).
const batch = (runId: string): CorpusRefinementInput => ({
  runId,
  mode: "archive",
  claims: [
    { id: "c0", statement: "Covered claim about meters.", covered: true },
    {
      id: "c1",
      statement: "The new mast is secretly making people in the town ill.",
      covered: false,
    },
    { id: "c2", statement: "Smart meters are a weapon.", covered: true },
    { id: "c3", statement: "5G towers spread the virus to residents.", covered: false },
  ],
  deferred: ["c9"],
});
// Saved coverage marks c1 and c3 uncovered.
const IDEAS_RESPONSE = JSON.stringify({
  ideas: [
    {
      id: "idea-masts-illness",
      statement: "Phone masts make people ill.",
      claimIds: ["c1"],
      evidence: [{ claimId: "c1", quote: "secretly making people in the town ill" }],
    },
    {
      id: "idea-towers-virus",
      statement: "Towers spread disease.",
      claimIds: ["c3"],
      evidence: [{ claimId: "c3", quote: "5G towers spread the virus" }],
    },
    // Invalid: c2 was covered, so not sent; the quote is invented too.
    {
      id: "idea-meters-weapon",
      statement: "Meters are weapons.",
      claimIds: ["c2"],
      evidence: [{ claimId: "c2", quote: "meters are a weapon" }],
    },
    // Invalid: fails the schema (no evidence).
    { id: "idea-no-evidence", statement: "x", claimIds: ["c1"], evidence: [] },
    // Invalid: valid on its own, but reuses an accepted idea's ID.
    {
      id: "idea-masts-illness",
      statement: "A different idea under the same ID.",
      claimIds: ["c3"],
      evidence: [{ claimId: "c3", quote: "spread the virus" }],
    },
  ],
});
const UNDERLYING_RESPONSE = JSON.stringify({
  underlying: [
    {
      id: "underlying-radiation-harm",
      statement: "Telecom infrastructure harms health.",
      ideaIds: ["idea-masts-illness", "idea-towers-virus"],
      rationale: "Both claim transmitters cause illness.",
    },
    // Invalid: reuses the accepted group's ID (its ideas are also taken).
    {
      id: "underlying-radiation-harm",
      statement: "Another proposition under the same ID.",
      ideaIds: ["idea-masts-illness", "idea-towers-virus"],
      rationale: "x",
    },
    // Invalid: one idea repeated is not two ideas.
    {
      id: "underlying-single",
      statement: "Only one idea, twice.",
      ideaIds: ["idea-towers-virus", "idea-towers-virus"],
      rationale: "x",
    },
    // Invalid: cites an idea the previous stage rejected.
    {
      id: "underlying-control",
      statement: "Devices control people.",
      ideaIds: ["idea-meters-weapon", "idea-masts-illness"],
      rationale: "x",
    },
  ],
});
// With a pinned catalogue (#852): one reuse proposal, one invalid reuse.
const CATALOGUE_RESPONSE = JSON.stringify({
  underlying: [
    {
      id: "transport-infrastructure-causes-illness",
      statement: "Telecom infrastructure makes people ill.",
      ideaIds: ["idea-masts-illness", "idea-towers-virus"],
      rationale: "Both allege illness from infrastructure, with no claim of intent.",
      match: { decision: "reuse", catalogueId: "transport-infrastructure-causes-illness" },
    },
    {
      id: "not-in-catalogue",
      statement: "x",
      ideaIds: ["idea-masts-illness", "idea-towers-virus"],
      rationale: "x",
      match: { decision: "reuse", catalogueId: "not-in-catalogue" },
    },
  ],
});
const provider = {
  modelVersion: "fake/corpus-model",
  calls: [] as { stage: string; user: string }[],
  async complete(request: { system: string; user: string; maxOutputChars: number }) {
    const stage = request.system.includes("underlying ideas") ? "underlying" : "ideas";
    this.calls.push({ stage, user: request.user });
    if (stage === "ideas") return IDEAS_RESPONSE;
    return JSON.parse(request.user).catalogue ? CATALOGUE_RESPONSE : UNDERLYING_RESPONSE;
  },
};

let dir: string;
let artifacts: GitArtifactStore;
let env: RestateTestEnvironment;
let ingress: clients.Ingress;
const crashAfterSave = new Set<string>();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "corpus-composed-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "corpus-test" });
  await artifacts.initialise();
  env = await RestateTestEnvironment.start(
    {
      services: [
        corpusRefinementWorkflow({
          artifacts: {
            lookup: (path) => artifacts.lookup(path),
            read: (ref) => artifacts.read(ref),
            write: async (path, content) => {
              const saved = await artifacts.write(path, content);
              if (crashAfterSave.delete(path)) throw new Error("synthetic save failure");
              return saved;
            },
          },
          provider,
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
const client = (runId: string) =>
  ingress.workflowClient<ReturnType<typeof corpusRefinementWorkflow>>(
    { name: "CorpusRefinement" },
    runId,
  );
const valueOf = async <T>(ref: unknown) =>
  (JSON.parse(await artifacts.read(ref as never)) as { value: T }).value;

describe("one composable stage for both mappings (#837)", { timeout: 120_000 }, () => {
  it("passes valid records forward, keeps issues visible, and never repeats a recorded call", async () => {
    provider.calls.length = 0;
    // The first mapping's save fails once, after its model result was recorded.
    crashAfterSave.add(corpusRefinementPath("run-composed", "map-claims-to-ideas"));
    const wf = client("run-composed");
    await wf.workflowSubmit(batch("run-composed"));
    const out = await wf.workflowAttach();

    // Coverage came from the saved flags, with the batch bounds recorded.
    const coverage = await valueOf<{ uncovered: string[]; deferred: string[] }>(
      out.stages[0]!.artifact,
    );
    expect(coverage.uncovered).toEqual(["c1", "c3"]);
    expect(coverage.deferred).toEqual(["c9"]);
    // One call per mapping, despite the save failure and retry.
    expect(provider.calls.map((c) => c.stage)).toEqual(["ideas", "underlying"]);
    // Only uncovered claims were sent to the first mapping.
    expect(JSON.parse(provider.calls[0]!.user).claims.map((c: { id: string }) => c.id)).toEqual([
      "c1",
      "c3",
    ]);

    const ideas = await valueOf<IdeasResult>(out.stages[1]!.artifact);
    expect(ideas.ideas.map((i) => i.id)).toEqual(["idea-masts-illness", "idea-towers-virus"]);
    expect(ideas.issues).toEqual([
      { index: 2, id: "idea-meters-weapon", reason: "unknown-claim:c2" },
      { index: 3, id: "idea-no-evidence", reason: "schema:evidence" },
      { index: 4, id: "idea-masts-illness", reason: "duplicate-idea:idea-masts-illness" },
    ]);
    expect(ideas.promptVersion).toMatch(/^corpus-refinement-map-claims-to-ideas-sha256:/);
    // Group sizes are recorded with the result (#849).
    expect(ideas.grouping).toEqual({ claims: 2, ideas: 2, sizes: { "1": 2 } });
    expect(ideas.model).toBe("fake/corpus-model");

    // The second mapping received only the accepted ideas.
    expect(JSON.parse(provider.calls[1]!.user).ideas.map((i: { id: string }) => i.id)).toEqual([
      "idea-masts-illness",
      "idea-towers-virus",
    ]);
    const underlying = await valueOf<UnderlyingResult>(out.stages[2]!.artifact);
    expect(underlying.underlying.map((u) => u.id)).toEqual(["underlying-radiation-harm"]);
    expect(underlying.issues).toEqual([
      {
        index: 1,
        id: "underlying-radiation-harm",
        reason: "idea-in-two-groups:idea-masts-illness",
      },
      { index: 2, id: "underlying-single", reason: "repeated-idea:idea-towers-virus" },
      { index: 3, id: "underlying-control", reason: "unknown-idea:idea-meters-weapon" },
    ]);
    expect(underlying.promptVersion).toMatch(
      /^corpus-refinement-map-ideas-to-underlying-ideas-sha256:/,
    );

    // A duplicate submission replays: no further model calls.
    await wf.workflowSubmit(batch("run-composed"));
    await wf.workflowAttach();
    expect(provider.calls).toHaveLength(2);
  });

  it("proposes catalogue reuse against a pinned version and never edits the catalogue (#852)", async () => {
    provider.calls.length = 0;
    const saved = await artifacts.write(CATALOGUE_PATH, JSON.stringify(SEED_CATALOGUE));
    const catalogue = {
      repository: saved.repository,
      commit: saved.commit,
      path: saved.path,
      sha256: saved.sha256,
    };
    const wf = client("run-catalogue");
    await wf.workflowSubmit({ ...batch("run-catalogue"), catalogue });
    const out = await wf.workflowAttach();

    // The mapper saw the reviewed entries as data.
    const sent = JSON.parse(provider.calls[1]!.user) as { catalogue: { id: string }[] };
    expect(sent.catalogue.map((e) => e.id)).toEqual(SEED_CATALOGUE.entries.map((e) => e.id));
    // The proposal is saved with its rationale and the exact catalogue version.
    const underlying = await valueOf<UnderlyingResult>(out.stages[2]!.artifact);
    expect(underlying.catalogue).toEqual(catalogue);
    expect(underlying.underlying.map((u) => [u.id, u.match])).toEqual([
      [
        "transport-infrastructure-causes-illness",
        { decision: "reuse", catalogueId: "transport-infrastructure-causes-illness" },
      ],
    ]);
    expect(underlying.underlying[0]!.rationale).toMatch(/no claim of intent/);
    expect(underlying.issues).toEqual([
      { index: 1, id: "not-in-catalogue", reason: "unknown-catalogue-id:not-in-catalogue" },
    ]);
    // Only reviewed changes reach later batches: the catalogue is untouched.
    expect((await artifacts.lookup(CATALOGUE_PATH))?.commit).toBe(saved.commit);
  });

  it("fails a run whose pinned catalogue is not valid JSON, without retrying (#852)", async () => {
    const saved = await artifacts.write("corpus-refinement/catalogue/broken.json", "{not json");
    const wf = client("run-bad-catalogue");
    await wf.workflowSubmit({
      ...batch("run-bad-catalogue"),
      catalogue: {
        repository: saved.repository,
        commit: saved.commit,
        path: saved.path,
        sha256: saved.sha256,
      },
    });
    await expect(wf.workflowAttach()).rejects.toThrow(/pinned catalogue is not a valid catalogue/);
  });
});
