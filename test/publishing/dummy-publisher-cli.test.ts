import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { provisionDurableConsumer } from "../../src/controllers/nats-provision.js";
import { NatsController } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  ARTICLE_APPROVED_SUBJECT,
  PUBLICATION_STREAM,
} from "../../src/events/article-approved-event.js";
import { recordApproval } from "../../src/publishing/approved-article.js";
import { approvedReport } from "./approval-fixtures.js";

// The deployed entry point (#315): two dummy publishers, each with its own
// durable consumer and destination name, persist their own receipt for the
// same approved revision; a redelivered approval reuses both receipts.
let dir: string;
let container: StartedTestContainer;
let url: string;
let nats: NatsController;
let content: GitArtifactStore;
const children: ChildProcess[] = [];
const lines: Record<string, Array<Record<string, unknown>>> = { a: [], b: [] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, check: () => T | undefined, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-dummy-publisher-"));
  await mkdir(join(dir, "content"));
  content = new GitArtifactStore({ repoPath: join(dir, "content"), repository: "content" });
  await content.initialise();
  container = await new GenericContainer("nats:2.10.22")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  url = `nats://${container.getHost()}:${container.getMappedPort(4222)}`;
  nats = new NatsController(url);
  await nats.connect("dummy-publisher-test");
  const jsm = await nats.manager();
  await jsm.streams.add({ name: PUBLICATION_STREAM, subjects: [ARTICLE_APPROVED_SUBJECT] });
  for (const x of ["a", "b"])
    await provisionDurableConsumer(nats, {
      stream: PUBLICATION_STREAM,
      name: `dummy-${x}`,
      filterSubject: ARTICLE_APPROVED_SUBJECT,
      maxDeliver: 300, // as provision.ts configures publisher consumers
    });
}, 120_000);

afterAll(async () => {
  for (const c of children) c.kill("SIGTERM");
  await nats?.close();
  await container?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("dummy-publisher", { timeout: 180_000 }, () => {
  it("persists one receipt per destination and reuses them on redelivery", async () => {
    const statePath = join(dir, "state.sqlite");
    const operations = new OperationStore({ path: statePath });
    const report = await approvedReport(content);
    const { eventId } = await recordApproval({ content, operations, report });
    const payload = operations.pendingEvent(eventId)!.payload;
    operations.close();

    for (const x of ["a", "b"] as const) {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli/dummy-publisher.ts"], {
        env: {
          ...process.env,
          NATS_URL: url,
          STEELE_CONTENT_PATH: join(dir, "content"),
          STEELE_CONTENT_REPOSITORY: "content",
          STEELE_STATE_PATH: statePath,
          STEELE_PUBLISHER_DESTINATION: `dummy-${x}`,
          STEELE_PUBLISHER_CONSUMER: `dummy-${x}`,
          STEELE_PUBLISHER_RETRY_DELAY_MS: "500",
        },
        stdio: ["ignore", "pipe", "inherit"],
      });
      children.push(child);
      let buffer = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (line.trim()) lines[x].push(JSON.parse(line));
        }
      });
    }
    await until("both consuming", () =>
      lines.a.some((l) => l.state === "consuming") && lines.b.some((l) => l.state === "consuming")
        ? true
        : undefined,
    );

    const encode = (s: string) => new TextEncoder().encode(s);
    await nats.publish(ARTICLE_APPROVED_SUBJECT, encode(payload), { msgId: eventId });
    const delivered = (x: "a" | "b") => lines[x].find((l) => l.outcome === "delivered");
    await until("both delivered", () => (delivered("a") && delivered("b") ? true : undefined));
    expect(delivered("a")!.receipt).toMatch(/^publications\/dummy-a\/draft\//);
    expect(delivered("b")!.receipt).toMatch(/^publications\/dummy-b\/draft\//);
    const receipts = (await content.list("publications", 100)).filter((p) =>
      p.endsWith("receipt.json"),
    );
    expect(receipts).toHaveLength(2);
    const first = (await content.lookup(receipts[0]!))!;
    expect(JSON.parse(await content.read(first))).toMatchObject({ simulated: true });

    // Redelivery under a new message ID: both reuse their receipts.
    await nats.publish(ARTICLE_APPROVED_SUBJECT, encode(payload), { msgId: `${eventId}-replay` });
    const reused = (x: "a" | "b") => lines[x].find((l) => l.outcome === "reused");
    await until("both reused", () => (reused("a") && reused("b") ? true : undefined));
    expect(
      (await content.list("publications", 100)).filter((p) => p.endsWith("receipt.json")),
    ).toHaveLength(2);
  });
});
