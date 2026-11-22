import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { FULLTEXT_INDEX_MAPPING } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { ElasticsearchController } from "../../src/controllers/elasticsearch.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { probeCapturedIndex } from "../../src/diagnostics/captured-index-probe.js";

const stateOptions = {
  workerUrl: new URL("../../src/diagnostics/state-probe-worker.ts", import.meta.url),
  execArgv: ["--import", "tsx"],
};
const INDEX = "steele-probe-source-text";

let container: StartedTestContainer;
let esUrl: string;
let dir: string;
let archive: GitArtifactStore;
let head: string;

beforeAll(async () => {
  container = await new GenericContainer("docker.elastic.co/elasticsearch/elasticsearch:8.19.2")
    .withEnvironment({
      "discovery.type": "single-node",
      "xpack.security.enabled": "false",
      ES_JAVA_OPTS: "-Xms512m -Xmx512m",
    })
    .withExposedPorts(9200)
    .withWaitStrategy(Wait.forHttp("/_cluster/health?wait_for_status=yellow", 9200))
    .withStartupTimeout(180_000)
    .start();
  esUrl = `http://${container.getHost()}:${container.getMappedPort(9200)}`;
  const es = new ElasticsearchController(esUrl);
  await es.provisionIndex(INDEX, FULLTEXT_INDEX_MAPPING);
  await es.close();
  dir = await mkdtemp(join(tmpdir(), "steele-captured-probe-"));
  await mkdir(join(dir, "raw"));
  archive = new GitArtifactStore({ repoPath: join(dir, "raw"), repository: "archive" });
  await archive.initialise();
  head = (await archive.write("substack/pub/p1/collected.json", "{}")).commit;
  await writeFile(join(dir, "checkpoint.json"), JSON.stringify({ commit: head }));
  new OperationStore({ path: join(dir, "state.sqlite") }).close();
}, 240_000);
afterAll(async () => {
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

const config = () => ({
  archive: { path: join(dir, "raw"), repository: "archive" },
  checkpointPath: join(dir, "checkpoint.json"),
  elasticsearch: { url: esUrl },
  index: INDEX,
  statePath: join(dir, "state.sqlite"),
  stateOptions,
  timeoutMs: 10_000,
});

describe("captured-post indexer probe (#326)", () => {
  it("is ready for a working fixture and reports progress separately", async () => {
    const report = await probeCapturedIndex(config());
    expect(report).toMatchObject({
      role: "captured-index-worker",
      live: true,
      ready: true,
      checks: { archive: "healthy", trigger: "healthy", search: "healthy", state: "healthy" },
      details: { checkpoint: head.slice(0, 12), unindexedChanges: 0 },
    });
    // A backlog is progress, not a readiness failure.
    await archive.write("substack/pub/p2/collected.json", "{}");
    const behind = await probeCapturedIndex(config());
    expect(behind.ready).toBe(true);
    expect(behind.details).toMatchObject({ unindexedChanges: 1 });
  }, 60_000);

  it("reports a lost checkpoint, then recovers when it is restored", async () => {
    await rm(join(dir, "checkpoint.json"));
    const lost = await probeCapturedIndex(config());
    expect(lost.ready).toBe(false);
    expect(lost.checks).toMatchObject({ trigger: "unavailable", archive: "healthy" });
    await writeFile(join(dir, "checkpoint.json"), JSON.stringify({ commit: head }));
    expect((await probeCapturedIndex(config())).ready).toBe(true);
  }, 60_000);

  it("reports a missing index and unreachable dependencies separately, leaking nothing", async () => {
    const missingIndex = await probeCapturedIndex({ ...config(), index: "steele-no-such-index" });
    expect(missingIndex.checks).toMatchObject({ search: "unavailable", trigger: "healthy" });
    const down = await probeCapturedIndex({
      ...config(),
      elasticsearch: { url: "http://127.0.0.1:1", apiKey: "SYNTHETIC-es-key" },
      archive: { path: join(dir, "missing"), repository: "archive" },
      statePath: join(dir, "missing.sqlite"),
      timeoutMs: 3_000,
    });
    expect(down.checks).toEqual({
      archive: "unavailable",
      trigger: "healthy",
      search: "unavailable",
      state: "unavailable",
    });
    const text = JSON.stringify(down);
    for (const secret of ["SYNTHETIC-es-key", "127.0.0.1", dir]) expect(text).not.toContain(secret);
  }, 60_000);

  it("reports unconfigured dependencies as not-configured", async () => {
    expect((await probeCapturedIndex({})).checks).toEqual({
      archive: "not-configured",
      trigger: "not-configured",
      search: "not-configured",
      state: "not-configured",
    });
  });
});
