import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { FULLTEXT_INDEX_MAPPING } from "../../src/content/fulltext-document.js";
import { ElasticsearchController } from "../../src/controllers/elasticsearch.js";
import { NatsController } from "../../src/controllers/nats.js";
import {
  provisionDiscoveryStream,
  provisionDurableConsumer,
} from "../../src/controllers/nats-provision.js";
import { probeTextReadyIndexer } from "../../src/diagnostics/text-ready-indexer-probe.js";
import { TEXT_READY_SUBJECT } from "../../src/events/text-ready-event.js";

const STREAM = "STEELE_TEXT_READY_PROBE";
const CONSUMER = "steele-indexer-probe-test";
const INDEX = "steele-probe-text-ready";

let nats: StartedTestContainer;
let search: StartedTestContainer;
let natsUrl: string;
let esUrl: string;
let admin: NatsController;

beforeAll(async () => {
  [nats, search] = await Promise.all([
    new GenericContainer("nats:2.10.22")
      .withCommand(["-js"])
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
      .start(),
    new GenericContainer("docker.elastic.co/elasticsearch/elasticsearch:8.19.2")
      .withEnvironment({
        "discovery.type": "single-node",
        "xpack.security.enabled": "false",
        ES_JAVA_OPTS: "-Xms512m -Xmx512m",
      })
      .withExposedPorts(9200)
      .withWaitStrategy(Wait.forHttp("/_cluster/health?wait_for_status=yellow", 9200))
      .withStartupTimeout(180_000)
      .start(),
  ]);
  natsUrl = `nats://${nats.getHost()}:${nats.getMappedPort(4222)}`;
  esUrl = `http://${search.getHost()}:${search.getMappedPort(9200)}`;
  admin = new NatsController(natsUrl);
  await admin.connect("probe-test-admin");
  await provisionDiscoveryStream(admin, { name: STREAM, subjects: [TEXT_READY_SUBJECT] });
  await provisionDurableConsumer(admin, {
    stream: STREAM,
    name: CONSUMER,
    filterSubject: TEXT_READY_SUBJECT,
  });
  const es = new ElasticsearchController(esUrl);
  await es.provisionIndex(INDEX, FULLTEXT_INDEX_MAPPING);
  await es.close();
}, 240_000);
afterAll(async () => {
  await admin?.close();
  await Promise.all([nats?.stop(), search?.stop()]);
});

const config = () => ({
  nats: { url: natsUrl },
  stream: STREAM,
  consumer: CONSUMER,
  elasticsearch: { url: esUrl },
  index: INDEX,
  timeoutMs: 10_000,
});

describe("legacy text-ready indexer probe (#325)", () => {
  it("is ready for a working fixture", async () => {
    expect(await probeTextReadyIndexer(config())).toEqual({
      schemaVersion: 1,
      role: "text-ready-indexer",
      live: true,
      ready: true,
      checks: { broker: "healthy", consumer: "healthy", search: "healthy" },
    });
  }, 60_000);

  it("reports a missing consumer, then recovers when it is provisioned again", async () => {
    await (await admin.manager()).consumers.delete(STREAM, CONSUMER);
    const missing = await probeTextReadyIndexer(config());
    expect(missing.checks).toEqual({
      broker: "healthy",
      consumer: "unavailable",
      search: "healthy",
    });
    // The probe did not recreate it.
    await expect((await admin.manager()).consumers.info(STREAM, CONSUMER)).rejects.toThrow();
    await provisionDurableConsumer(admin, {
      stream: STREAM,
      name: CONSUMER,
      filterSubject: TEXT_READY_SUBJECT,
    });
    expect((await probeTextReadyIndexer(config())).ready).toBe(true);
  }, 60_000);

  it("reports a missing index and unreachable services separately, leaking nothing", async () => {
    expect(
      (await probeTextReadyIndexer({ ...config(), index: "steele-no-such-index" })).checks,
    ).toEqual({ broker: "healthy", consumer: "healthy", search: "unavailable" });
    const down = await probeTextReadyIndexer({
      ...config(),
      nats: { url: "nats://127.0.0.1:1", token: "SYNTHETIC-token" },
      elasticsearch: { url: "http://127.0.0.1:2", apiKey: "SYNTHETIC-es-key" },
      timeoutMs: 3_000,
    });
    expect(down.checks).toEqual({
      broker: "unavailable",
      consumer: "unavailable",
      search: "unavailable",
    });
    const text = JSON.stringify(down);
    for (const secret of ["SYNTHETIC-token", "SYNTHETIC-es-key", "127.0.0.1"])
      expect(text).not.toContain(secret);
  }, 60_000);

  it("reports unconfigured dependencies as not-configured", async () => {
    expect((await probeTextReadyIndexer({})).checks).toEqual({
      broker: "not-configured",
      consumer: "not-configured",
      search: "not-configured",
    });
  });
});
