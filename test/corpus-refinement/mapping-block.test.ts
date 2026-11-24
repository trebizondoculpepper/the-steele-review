import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { saveBatch, toBatch } from "../../src/corpus-refinement/batch.js";
import { SEED_CATALOGUE } from "../../src/corpus-refinement/catalogue.js";
import type { StageRef } from "../../src/corpus-refinement/contracts.js";
import {
  dispose,
  mappingPath,
  runMappingBlock,
  type ClassifierDecision,
  type MappingClassifier,
} from "../../src/corpus-refinement/mapping-block.js";

// Fixture decisions only: the classifier is injected (#861).
const ENTRY = SEED_CATALOGUE.entries[0]!.id;
const records = ["c1", "c2", "c3", "c4", "c5"].map((id) => ({
  id,
  statement: `Statement ${id}.`,
  post: "pub/post",
}));

describe("mapping dispositions (#861)", () => {
  it("gives every unique input exactly one disposition, with reasons", () => {
    const decisions: ClassifierDecision[] = [
      {
        recordId: "c1",
        decision: "mapped",
        catalogueId: ENTRY,
        confidence: "high",
        rationale: "same claim",
      },
      { recordId: "c1", decision: "unmapped", reason: "second opinion ignored" },
      { recordId: "c2", decision: "unmapped", reason: "new-idea" },
      { recordId: "c3", decision: "mapped", catalogueId: "no-such-entry", confidence: "high" },
      { recordId: "c4", decision: "mapped", catalogueId: ENTRY, confidence: "low" },
      // c5: no decision at all.
    ];
    const out = dispose([...records, records[0]!], decisions, SEED_CATALOGUE, {
      minConfidence: "medium",
    });
    expect(out.mapped).toEqual([
      { id: "c1", catalogueId: ENTRY, confidence: "high", rationale: "same claim" },
    ]);
    expect(out.unmapped).toEqual([
      { id: "c2", reason: "new-idea" },
      { id: "c3", reason: "unknown-catalogue-id:no-such-entry" },
      { id: "c4", reason: "below-confidence:low" },
      { id: "c5", reason: "no-decision" },
    ]);
    expect(out.order.map((o) => o.id)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });
});

let dir: string;
let artifacts: GitArtifactStore;
let env: RestateTestEnvironment;
let ingress: clients.Ingress;
let catalogueRef: StageRef;
const crashAfterSave = new Set<string>();
let classifyCalls = 0;
let failClassifyOnce = false;
const classifier: MappingClassifier = {
  version: "fixture-v1",
  async classify(input) {
    classifyCalls++;
    if (failClassifyOnce) {
      failClassifyOnce = false;
      throw new Error("synthetic provider outage");
    }
    return input.map((r, i): ClassifierDecision =>
      i % 2 === 0
        ? { recordId: r.id, decision: "mapped", catalogueId: ENTRY, confidence: "high" }
        : { recordId: r.id, decision: "unmapped", reason: "new-idea" },
    );
  },
};
const plainRef = (r: { repository: string; commit: string; path: string; sha256: string }) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.sha256,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mapping-block-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "corpus-test" });
  await artifacts.initialise();
  catalogueRef = plainRef(
    await artifacts.write(
      "corpus-refinement/catalogue/underlying-ideas.json",
      JSON.stringify(SEED_CATALOGUE),
    ),
  );
  const store = {
    read: (ref: never) => artifacts.read(ref),
    lookup: (path: string) => artifacts.lookup(path),
    write: async (path: string, content: string) => {
      const saved = await artifacts.write(path, content);
      if (crashAfterSave.delete(path)) throw new Error("synthetic save failure");
      return saved;
    },
  };
  const service = restate.service({
    name: "MappingBlockTest",
    handlers: {
      map: async (
        ctx: restate.Context,
        req: { runId: string; batch: StageRef; catalogue?: StageRef },
      ) =>
        runMappingBlock(
          ctx,
          { artifacts: store, classifier },
          {
            runId: req.runId,
            batch: req.batch,
            catalogue: req.catalogue ?? catalogueRef,
            settings: { minConfidence: "medium" },
          },
        ),
    },
  });
  env = await RestateTestEnvironment.start(
    { services: [service], serviceEndpointAccess: "docker-host" },
    () => new RestateContainer("1.8.1"),
  );
  ingress = clients.connect({ url: env.baseUrl() });
}, 240_000);
afterAll(async () => {
  await env?.stop();
  await rm(dir, { recursive: true, force: true });
});

const run = async (runId: string, ids: string[]) => {
  const batch = toBatch({
    runId,
    mode: "archive",
    claims: ids.map((id) => ({ id, statement: `Statement ${id}.`, post: "pub/post" })),
  }).batch;
  const ref = plainRef(await saveBatch(artifacts, batch));
  const out = await ingress
    .serviceClient<{
      map: (r: {
        runId: string;
        batch: StageRef;
      }) => Promise<{ mapped: StageRef; unmapped: StageRef }>;
    }>({
      name: "MappingBlockTest",
    })
    .map({ runId, batch: ref });
  const read = async (r: StageRef) => JSON.parse(await artifacts.read(r as never));
  return { ref, out, mapped: await read(out.mapped), unmapped: await read(out.unmapped) };
};

describe("the mapping block in Restate (#861)", { timeout: 120_000 }, () => {
  it("routes a mixed batch to mapped and unmapped outputs, carrying source references", async () => {
    const { ref, mapped, unmapped } = await run("map-mixed", ["c1", "c2", "c3"]);
    expect(mapped.records.map((r: { source: { recordId: string } }) => r.source.recordId)).toEqual([
      "c1",
      "c3",
    ]);
    expect(unmapped.records).toEqual([
      { source: { batch: ref, recordId: "c2", post: "pub/post" }, reason: "new-idea" },
    ]);
    expect(mapped.records[0]).toMatchObject({
      catalogueId: ENTRY,
      confidence: "high",
      source: { batch: ref },
    });
    expect(mapped).toMatchObject({
      kind: "corpus-mapping-mapped",
      classifier: "fixture-v1",
      catalogue: catalogueRef,
    });
  });

  it("saves both outputs for an empty batch", async () => {
    const { mapped, unmapped } = await run("map-empty", []);
    expect([mapped.records, unmapped.records]).toEqual([[], []]);
  });

  it("recovers between the two saves without a second classification or duplicate records", async () => {
    crashAfterSave.add(mappingPath("map-retry", "mapped"));
    const before = classifyCalls;
    const { mapped, unmapped } = await run("map-retry", ["c1", "c2"]);
    expect(classifyCalls).toBe(before + 1);
    expect([mapped.records.length, unmapped.records.length]).toEqual([1, 1]);
    expect(await artifacts.list("corpus-refinement/map-retry/mapping", 10)).toHaveLength(2);
  });

  it("retries a provider failure instead of calling the records unmapped", async () => {
    failClassifyOnce = true;
    const before = classifyCalls;
    const { mapped, unmapped } = await run("map-provider", ["c1", "c2"]);
    expect(classifyCalls).toBe(before + 2);
    expect(unmapped.records.map((r: { reason: string }) => r.reason)).toEqual(["new-idea"]);
    expect(mapped.records).toHaveLength(1);
  });

  it("fails terminally on a pinned catalogue that is not valid JSON", async () => {
    const broken = plainRef(
      await artifacts.write("corpus-refinement/catalogue/broken.json", "{not json"),
    );
    const batch = plainRef(
      await saveBatch(
        artifacts,
        toBatch({ runId: "map-broken", mode: "archive", claims: [{ id: "c1", statement: "S." }] })
          .batch,
      ),
    );
    await expect(
      ingress
        .serviceClient<{ map: (r: unknown) => Promise<unknown> }>({ name: "MappingBlockTest" })
        .map({ runId: "map-broken", batch, catalogue: broken }),
    ).rejects.toThrow(/pinned catalogue is not usable/);
  });
});
