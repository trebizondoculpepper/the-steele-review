import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AckPolicy, DeliverPolicy } from "@nats-io/jetstream";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { NatsController } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { ARTICLE_APPROVED_SUBJECT } from "../../src/events/article-approved-event.js";

// The deployed entry point (#314): `--once` drains the state outbox that the
// article worker writes and publishes to STEELE_PUBLICATION, deduplicated by ID.
const run = promisify(execFile);
let dir: string;
let container: StartedTestContainer;
let url: string;
let nats: NatsController;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-dispatcher-cli-"));
  container = await new GenericContainer("nats:2.10.22")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  url = `nats://${container.getHost()}:${container.getMappedPort(4222)}`;
  nats = new NatsController(url);
  await nats.connect("dispatcher-cli-test");
  const jsm = await nats.manager();
  await jsm.streams.add({ name: "STEELE_PUBLICATION", subjects: [ARTICLE_APPROVED_SUBJECT] });
  await jsm.consumers.add("STEELE_PUBLICATION", {
    durable_name: "dest",
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    filter_subject: ARTICLE_APPROVED_SUBJECT,
  });
}, 120_000);

afterAll(async () => {
  await nats?.close();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

const once = (env: Record<string, string>) =>
  run(process.execPath, ["--import", "tsx", "src/cli/approval-dispatcher.ts", "--once"], {
    env: { ...process.env, ...env },
  });

describe("approval-dispatcher --once", () => {
  it("publishes a pending approval once and marks it sent", async () => {
    const statePath = join(dir, "state.sqlite");
    const ops = new OperationStore({ path: statePath });
    ops.reconcileCompleted("approved:evt-1", { eventId: "evt-1" }, [
      { eventId: "evt-1", subject: ARTICLE_APPROVED_SUBJECT, payload: '{"id":"evt-1"}' },
    ]);
    ops.close();

    const first = await once({ NATS_URL: url, STEELE_STATE_PATH: statePath });
    expect(JSON.parse(first.stdout.split("\n")[0]!)).toMatchObject({ sent: 1, retrying: 0 });
    // Nothing is due any more: a rerun publishes nothing.
    const second = await once({ NATS_URL: url, STEELE_STATE_PATH: statePath });
    expect(JSON.parse(second.stdout.split("\n")[0]!)).toMatchObject({ sent: 0, retrying: 0 });

    const jsm = await nats.manager();
    expect((await jsm.streams.info("STEELE_PUBLICATION")).state.messages).toBe(1);
  }, 60_000);

  it("refuses to start without its state path", async () => {
    await expect(once({ NATS_URL: url, STEELE_STATE_PATH: "" })).rejects.toMatchObject({
      code: 2,
    });
  });
});
