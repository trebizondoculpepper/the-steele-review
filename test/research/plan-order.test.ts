import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vite-plus/test";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment, RestateContainer } from "@restatedev/restate-sdk-testcontainers";
import { GitArtifactStore, type ArtifactRef } from "../../src/controllers/artifact-store.js";
import { proposeThemes } from "../../src/analysis/theme-proposals.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import {
  assessPostCoverage,
  newDossierId,
  LexicalShortlister,
  CoverageRecordSchema,
} from "../../src/research/librarian.js";
import { researchJobId, type ResearchRequest } from "../../src/research/job.js";
import {
  articleRunResult,
  articleRunWorkflow,
  researchService,
  type ArticleStages,
} from "../../src/workflow/article-run.js";

let dir: string, artifacts: GitArtifactStore;
const TEXT = "Five independent synthetic topics.";
const historical = ["Zulu", "Yankee", "Alpha", "Beta", "Gamma"];
const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-plan-order-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function seed(titles = [...historical].sort()) {
  const source = {
    repository: "archive",
    commit: "a".repeat(40),
    path: "substack/pub/p1/collected.json",
    hash: `sha256:${"b".repeat(64)}`,
  };
  const post = { publicationId: "pub", postId: "p1" };
  const out = await proposeThemes({
    artifacts,
    post,
    provider: {
      modelVersion: "fake/themes",
      complete: async () =>
        JSON.stringify({
          themes: titles.map((title) => ({
            title,
            description: `Distinct synthetic ${title} issue`,
          })),
        }),
    },
    source: { text: TEXT, sourceVersion: sourceVersionFor(TEXT), artifact: source },
  });
  if (out.status !== "proposed") throw new Error("fixture themes");
  const proposals = JSON.parse(await artifacts.read(out.ref)).proposals as {
    id: string;
    title: string;
  }[];
  const claims = await artifacts.write(
    "claim-extractions/pub/p1/claims.json",
    JSON.stringify({
      schemaVersion: 2,
      post,
      sourceVersion: sourceVersionFor(TEXT),
      themeIds: proposals.map((p) => p.id),
      themeResult: `${out.ref.commit}:${out.ref.path}`,
      claims: proposals.map((p) => ({
        claim: { statement: `A claim about ${p.title}.` },
        occurrence: {},
        kind: "assertion",
        themeIds: [p.id],
        classification: "themed",
        claimRecordId: `claim-${p.title.toLowerCase()}`,
      })),
      candidates: [],
      rejected: [],
      extraction: {
        modelVersion: "fake/claims",
        promptVersion: "synthetic",
        extractedAt: "2026-01-01T00:00:00Z",
      },
    }),
  );
  const themeResult = out.ref;
  const key = createHash("sha256")
    .update(JSON.stringify([ref(themeResult), ref(claims)]))
    .digest("hex")
    .slice(0, 32);
  const planPath = `librarian/request-plans/pub/p1/${key}.json`;
  const legacy = async (order: string[], suffix = "old") =>
    artifacts.write(
      `librarian/coverage/pub/p1/${suffix}.json`,
      JSON.stringify(
        CoverageRecordSchema.parse({
          schemaVersion: 1,
          post,
          source,
          themeResult: ref(themeResult),
          claimResult: ref(claims),
          mappings: proposals.map((p) => ({
            proposalId: p.id,
            title: p.title,
            dossierId: newDossierId(p.title),
            created: true,
            method: "lexical",
            rationale: "historical exact-analysis mapping",
          })),
          claims: [],
          jobs: order.map((title) => ({
            jobId: `historical-${title}`,
            dossierId: newDossierId(title),
            pass: 1,
            outcome: "pending",
          })),
          dossiers: [],
          assessedAt: "2026-01-01T00:00:00Z",
        }),
      ),
    );
  const plan = async () => {
    const requests: ResearchRequest[] = [];
    await assessPostCoverage({
      artifacts,
      themeResult,
      claimResult: claims,
      shortlister: new LexicalShortlister(),
      commission: async (request) => {
        requests.push(request);
        return { jobId: researchJobId(request), status: "busy" };
      },
    });
    return requests;
  };
  return { themeResult, claims, planPath, legacy, plan };
}

describe("retained commissioning priority", { timeout: 60_000 }, () => {
  it("preserves exact-analysis five-group priority despite sorted map keys, with stable job IDs on replay", async () => {
    const f = await seed();
    await f.legacy([historical[0]!, historical[0]!, ...historical.slice(1)]);
    const first = await f.plan();
    expect(first.map((r) => r.claims[0]!.themeIds[0])).toEqual(historical.map(newDossierId));
    const saved = (await artifacts.lookup(f.planPath))!;
    const plan = JSON.parse(await artifacts.read(saved));
    expect(plan.schemaVersion).toBe(2);
    expect(plan.order).toEqual(historical.map(newDossierId));
    expect(Object.keys(plan.dossiers)).not.toEqual(plan.order);
    const second = await f.plan();
    expect(second.map(researchJobId)).toEqual(first.map(researchJobId));
    expect(await artifacts.lookup(f.planPath)).toEqual(saved);
  });
  it("records extraction order before a coverage-write interruption and reuses it unchanged", async () => {
    const f = await seed(historical);
    const write = artifacts.write.bind(artifacts);
    let fail = true;
    vi.spyOn(artifacts, "write").mockImplementation(async (path, value, hash) => {
      if (path.startsWith("librarian/coverage/") && fail) {
        fail = false;
        throw new Error("synthetic interrupted coverage write");
      }
      return write(path, value, hash);
    });
    await expect(f.plan()).rejects.toThrow("synthetic interrupted coverage write");
    const saved = (await artifacts.lookup(f.planPath))!;
    expect(JSON.parse(await artifacts.read(saved)).order).toEqual(historical.map(newDossierId));
    expect((await f.plan()).map((r) => r.claims[0]!.themeIds[0])).toEqual(
      historical.map(newDossierId),
    );
    expect(await artifacts.lookup(f.planPath)).toEqual(saved);
  });
  it("keeps immutable v1 serialized order even when later history disagrees", async () => {
    const f = await seed();
    await f.legacy(historical);
    const order = [...historical].reverse();
    const saved = await artifacts.write(
      f.planPath,
      JSON.stringify({
        schemaVersion: 1,
        dossiers: Object.fromEntries(order.map((t) => [newDossierId(t), { mode: "full" }])),
      }),
    );
    expect((await f.plan()).map((r) => r.claims[0]!.themeIds[0])).toEqual(order.map(newDossierId));
    expect(await artifacts.lookup(f.planPath)).toEqual(saved);
  });
  it("refuses conflicting historical order and malformed v2 order before commissioning", async () => {
    const f = await seed();
    await f.legacy(historical);
    await f.legacy([...historical].reverse(), "conflict");
    await expect(f.plan()).rejects.toThrow("research-plan-order-conflict");
    expect(await artifacts.lookup(f.planPath)).toBeUndefined();
    await artifacts.write(
      f.planPath,
      JSON.stringify({
        schemaVersion: 2,
        dossiers: { [newDossierId("Zulu")]: { mode: "full" } },
        order: [newDossierId("Zulu"), newDossierId("Zulu")],
      }),
    );
    await expect(f.plan()).rejects.toThrow();
  });
  it("uses the original two-job prefix through normal Restate ArticleRun and replays without discovery", async () => {
    const f = await seed();
    const coverage = await f.legacy(historical);
    const all = await f.plan();
    const expected = historical
      .slice(0, 2)
      .map((t) => researchJobId(all.find((r) => r.claims[0]!.themeIds[0] === newDossierId(t))!));
    let researchCalls = 0,
      discoveryCalls = 0;
    const noDiscovery = () => {
      discoveryCalls++;
      throw new Error("discovery forbidden");
    };
    const stages: ArticleStages = {
      themes: async () => f.themeResult,
      claims: async () => f.claims,
      planResearch: f.plan,
      research: async (request) => {
        researchCalls++;
        if (!expected.includes(researchJobId(request))) noDiscovery();
        return { jobId: researchJobId(request), status: "finished" };
      },
      coverage: async () => coverage,
      package: async () => ({ ref: coverage, status: "ready" }),
      draft: async () => ({ failure: "synthetic stop after normal retained guard" }),
      verify: async () => {
        throw new Error("no editorial call in scheduling regression");
      },
      approve: async () => {
        throw new Error("no approval in scheduling regression");
      },
    };
    const workflow = articleRunWorkflow(stages);
    const env = await RestateTestEnvironment.start(
      { services: [workflow, researchService(stages)], serviceEndpointAccess: "docker-host" },
      () => new RestateContainer("1.8.1"),
    );
    try {
      const w = clients
        .connect({ url: env.baseUrl() })
        .workflowClient(workflow, "synthetic-order-upgrade");
      const input = {
        publicationId: "pub",
        postId: "p1",
        sourceVersion: sourceVersionFor(TEXT),
        sourceUrl: "https://source.example/post",
        researchDeadlineMs: 30_000,
        researchRequestLimit: 2,
        recoveryGeneration: 1,
        operatorRequestId: "order-upgrade",
        retainedResearchJobIds: expected,
      };
      await w.workflowSubmit(input);
      expect(
        await articleRunResult(
          () => Promise.resolve(w.workflowAttach()),
          () => Promise.resolve(w.final()),
        ),
      ).toMatchObject({
        outcome: "failed",
        reason: "synthetic stop after normal retained guard",
      });
      await w.workflowSubmit(input);
      await articleRunResult(
        () => Promise.resolve(w.workflowAttach()),
        () => Promise.resolve(w.final()),
      );
      expect(researchCalls).toBe(2);
      expect(discoveryCalls).toBe(0);
    } finally {
      await env.stop();
    }
  }, 240_000);
});
