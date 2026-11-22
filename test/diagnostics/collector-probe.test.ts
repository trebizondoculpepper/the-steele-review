import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { NatsController } from "../../src/controllers/nats.js";
import {
  provisionDiscoveryStream,
  provisionDurableConsumer,
} from "../../src/controllers/nats-provision.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { probeCollector } from "../../src/diagnostics/collector-probe.js";

/** The state-probe worker runs from source under the test runner. */
const stateOptions = {
  workerUrl: new URL("../../src/diagnostics/state-probe-worker.ts", import.meta.url),
  execArgv: ["--import", "tsx"],
};
const STREAM = "STEELE_PROBE_TEST";
const CONSUMER = "steele-collector-probe-test";
const SUBJECT = "steele.v1.source.detected";

let container: StartedTestContainer;
let url: string;
let dir: string;
let admin: NatsController;

beforeAll(async () => {
  container = await new GenericContainer("nats:2.10.22")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  url = `nats://${container.getHost()}:${container.getMappedPort(4222)}`;
  admin = new NatsController(url);
  await admin.connect("probe-test-admin");
  await provisionDiscoveryStream(admin, { name: STREAM, subjects: [SUBJECT] });
  await provisionDurableConsumer(admin, { stream: STREAM, name: CONSUMER, filterSubject: SUBJECT });
  dir = await mkdtemp(join(tmpdir(), "steele-collector-probe-"));
  await mkdir(join(dir, "raw.git"));
  await new GitArtifactStore({
    repoPath: join(dir, "raw.git"),
    repository: "archive",
  }).initialise();
  new OperationStore({ path: join(dir, "state.sqlite") }).close();
}, 120_000);
afterAll(async () => {
  await admin?.close();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

const config = () => ({
  nats: { url },
  stream: STREAM,
  consumer: CONSUMER,
  archive: { path: join(dir, "raw.git"), repository: "archive" },
  statePath: join(dir, "state.sqlite"),
  stateOptions,
  timeoutMs: 5_000,
});

describe("collector probe (#324)", () => {
  it("reports ready for a working collector fixture", async () => {
    const report = await probeCollector(config());
    expect(report).toEqual({
      schemaVersion: 1,
      role: "collector",
      live: true,
      ready: true,
      checks: { broker: "healthy", consumer: "healthy", archive: "healthy", state: "healthy" },
    });
  }, 60_000);

  it("reports a missing durable consumer, then recovers when it is provisioned again", async () => {
    await (await admin.manager()).consumers.delete(STREAM, CONSUMER);
    const missing = await probeCollector(config());
    expect(missing.ready).toBe(false);
    expect(missing.checks).toMatchObject({ broker: "healthy", consumer: "unavailable" });
    // The probe never recreated it.
    await expect((await admin.manager()).consumers.info(STREAM, CONSUMER)).rejects.toThrow();
    await provisionDurableConsumer(admin, {
      stream: STREAM,
      name: CONSUMER,
      filterSubject: SUBJECT,
    });
    expect((await probeCollector(config())).ready).toBe(true);
  }, 60_000);

  it("reports each unavailable dependency separately and leaks nothing", async () => {
    const report = await probeCollector({
      ...config(),
      nats: { url: "nats://127.0.0.1:1", token: "SYNTHETIC-token" },
      archive: { path: join(dir, "missing.git"), repository: "archive" },
      statePath: join(dir, "missing.sqlite"),
      timeoutMs: 3_000,
    });
    expect(report.checks).toEqual({
      broker: "unavailable",
      consumer: "unavailable",
      archive: "unavailable",
      state: "unavailable",
    });
    const text = JSON.stringify(report);
    for (const secret of ["SYNTHETIC-token", "127.0.0.1", dir]) expect(text).not.toContain(secret);
  }, 60_000);

  it("reports unconfigured dependencies as not-configured", async () => {
    const report = await probeCollector({});
    expect(report).toMatchObject({
      live: true,
      ready: false,
      checks: {
        broker: "not-configured",
        consumer: "not-configured",
        archive: "not-configured",
        state: "not-configured",
      },
    });
  });
});
