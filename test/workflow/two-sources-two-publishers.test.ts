import { classifyArticlePath } from "../../src/drafting/article-identity.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { AckPolicy, DeliverPolicy } from "@nats-io/jetstream";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { NatsController, type DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { ARTICLE_APPROVED_SUBJECT } from "../../src/events/article-approved-event.js";
import {
  CAPTURED_CONTENT_SUBJECT,
  createCapturedContentEvent,
} from "../../src/events/captured-content-event.js";
import { dispatchApprovedArticles } from "../../src/publishing/approval-dispatch.js";
import {
  handleApprovedArticle,
  SimulatedDestination,
  type DeliveryDecision,
} from "../../src/publishing/approved-article.js";
import { FIXTURE_TEXT as TEXT, fixtureProviders } from "../../src/workflow/article-fixture.js";
import {
  RESEARCH_CONCURRENCY_RULE,
  articleRunTarget,
  articleRunWorkflow,
  researchService,
  type ArticleRunApi,
  type ArticleRunInput,
} from "../../src/workflow/article-run.js";
import { handleCapturedContent } from "../../src/workflow/captured-bridge.js";
import { articleStages } from "../../src/workflow/stages.js";

/**
 * Many sources, one writing engine, many publishers (#271, part of #268).
 *
 * One integrated run across the real boundaries: two sources (Substack and a
 * second, non-Substack fixture source) emit captured-content events on a real
 * JetStream; the bridge submits each to the real Restate `ArticleRun`
 * workflow, whose stages are the production stages with deterministic
 * fixture models and research; each verified run records an approval in the
 * outbox; the outbox dispatcher publishes it to the publisher stream; and two
 * simulated destinations consume it independently, each saving its own
 * receipt. One destination fails once and recovers. Replaying a captured
 * event and an approval event duplicates neither drafts nor deliveries.
 * Requires Docker.
 */

const SOURCES = [
  {
    namespace: "substack/pub",
    kind: "substack",
    itemId: "weather",
    path: "substack/pub/weather/collected.json",
    item: { publicationId: "pub", postId: "weather", url: "https://pub.example.com/p/weather" },
  },
  {
    namespace: "blog/example-site",
    kind: "blog",
    itemId: "a-post",
    path: "blog/example-site/a-post/collected.json",
    // The second fixture uses the current capture-record representation (#271
    // answer 2); its item carries the namespaced work identity, never a bare
    // name that could collide with a Substack publication.
    item: {
      ...articleRunTarget("blog/example-site", "a-post"),
      url: "https://example-site.test/a-post",
    },
  },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

let dir: string;
let archive: GitArtifactStore;
let content: GitArtifactStore;
let operations: OperationStore;
let natsContainer: StartedTestContainer;
let nats: NatsController;
let restate: RestateTestEnvironment;
let ingress: clients.Ingress;
const abort = new AbortController();
const loops: Promise<void>[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-two-sources-"));
  await mkdir(join(dir, "a"));
  await mkdir(join(dir, "c"));
  archive = new GitArtifactStore({ repoPath: join(dir, "a"), repository: "archive" });
  content = new GitArtifactStore({ repoPath: join(dir, "c"), repository: "content" });
  await archive.initialise();
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
  for (const s of SOURCES) {
    await archive.write(
      s.path,
      JSON.stringify({
        item: { ...s.item, title: "Weather" },
        ingestionReason: "live",
        text: TEXT,
        complete: true,
        supplied: {},
        provenance: {
          sourceUrl: s.item.url,
          acquiredAt: "2026-01-01T00:00:00.000Z",
          method: "article-html",
        },
      }),
    );
  }

  natsContainer = await new GenericContainer("nats:2.10.22")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  nats = new NatsController(
    `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`,
  );
  await nats.connect("steele-two-sources-test");
  const jsm = await nats.manager();
  await jsm.streams.add({ name: "STEELE_CONTENT", subjects: [CAPTURED_CONTENT_SUBJECT] });
  await jsm.streams.add({ name: "STEELE_PUBLICATION", subjects: [ARTICLE_APPROVED_SUBJECT] });
  const durable = (name: string, subject: string) => ({
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    filter_subject: subject,
    ack_wait: 30_000_000_000,
  });
  await jsm.consumers.add("STEELE_CONTENT", durable("bridge", CAPTURED_CONTENT_SUBJECT));
  await jsm.consumers.add("STEELE_PUBLICATION", durable("dest-a", ARTICLE_APPROVED_SUBJECT));
  await jsm.consumers.add("STEELE_PUBLICATION", durable("dest-b", ARTICLE_APPROVED_SUBJECT));

  const stages = articleStages({
    archive,
    content,
    operations,
    ...fixtureProviders(),
    owner: "test",
  });
  restate = await RestateTestEnvironment.start(
    { services: [articleRunWorkflow(stages), researchService(stages)] },
    () => new RestateContainer("1.8.1"),
  );
  const put = await fetch(`${restate.adminAPIBaseUrl()}/limits/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(RESEARCH_CONCURRENCY_RULE),
  });
  expect(put.ok).toBe(true);
  ingress = clients.connect({ url: restate.baseUrl() });
}, 300_000);

afterAll(async () => {
  abort.abort();
  await Promise.allSettled(loops);
  await nats?.close();
  await restate?.stop();
  await natsContainer?.stop();
  operations?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Apply a decision to a delivered message, as the production workers do. */
async function settle(
  message: DeliveredMessage,
  decision: { action: "ack" } | { action: "nak"; delayMs: number } | { action: "term" },
) {
  if (decision.action === "ack") await message.ack();
  else if (decision.action === "nak") message.nak(decision.delayMs);
  else message.term();
}

describe("many sources, one writing engine, many publishers (#271)", { timeout: 300_000 }, () => {
  it("delivers each approved revision from both sources to two independent destinations", async () => {
    // Two sources emit one captured-content event each, on the real stream.
    const payloads: string[] = [];
    for (const s of SOURCES) {
      const ref = (await archive.lookup(s.path))!;
      const event = createCapturedContentEvent({
        source: { namespace: s.namespace, kind: s.kind },
        itemId: s.itemId,
        originalUrl: s.item.url,
        artifact: {
          repository: ref.repository,
          commit: ref.commit,
          path: ref.path,
          hash: `sha256:${ref.sha256}`,
        },
        sourceVersion: sourceVersionFor(TEXT),
        complete: true,
        transcript: { kind: "none" },
        ingestionReason: "live",
      });
      const payload = JSON.stringify(event.toJSON());
      payloads.push(payload);
      await nats.publish(CAPTURED_CONTENT_SUBJECT, new TextEncoder().encode(payload), {
        msgId: event.id,
      });
    }

    // The bridge: the real consumer loop and handler, submitting to Restate.
    const submitted = new Map<string, "started" | "already-running">();
    const bridgeOptions = {
      enabledSources: new Set(SOURCES.map((s) => s.namespace)),
      researchDeadlineMs: 20_000,
      retryDelayMs: 500,
      submit: async (key: string, input: ArticleRunInput) => {
        const s = await ingress
          .workflowClient<ArticleRunApi>({ name: "ArticleRun" }, key)
          .workflowSubmit(input);
        const outcome = s.status === "PreviouslyAccepted" ? "already-running" : "started";
        submitted.set(key, submitted.has(key) ? "already-running" : outcome);
        return outcome;
      },
    };
    loops.push(
      nats.consume(
        "STEELE_CONTENT",
        "bridge",
        async (m) =>
          settle(m, await handleCapturedContent(new TextDecoder().decode(m.data), bridgeOptions)),
        abort.signal,
      ),
    );
    await until("both runs submitted", () => (submitted.size === 2 ? true : undefined));
    const keys = [...submitted.keys()];

    // One writing engine: both revisions verified, each with one approval.
    const results = await Promise.all(
      keys.map((key) =>
        ingress.workflowClient<ArticleRunApi>({ name: "ArticleRun" }, key).workflowAttach(),
      ),
    );
    for (const r of results)
      expect(r).toMatchObject({ outcome: "verified", approvalEvent: expect.any(String) });
    const drafts = await content.list("articles", 1_000);
    // One write-once generation draft per source, and one in-place logical
    // article per source (#579), never a second article for a retry.
    const draftCount = drafts.filter(
      (p) => classifyArticlePath(p)?.kind === "legacy-generation" && p.endsWith(".md"),
    ).length;
    expect(draftCount).toBe(2);
    const articleCount = drafts.filter(
      (p) => classifyArticlePath(p)?.kind === "canonical" && p.endsWith("/article.md"),
    ).length;
    expect(articleCount).toBe(2);

    // The outbox dispatcher is the only path to the publisher stream.
    expect(await dispatchApprovedArticles({ operations, publisher: nats })).toEqual({
      sent: 2,
      retrying: 0,
    });

    // Two independent destinations; B fails once and recovers by redelivery.
    const a = new SimulatedDestination("site-a", "draft");
    const b = new SimulatedDestination("site-b", "draft", { failTimes: 1 });
    const decisions: Record<string, DeliveryDecision[]> = { a: [], b: [] };
    for (const [name, consumer, destination] of [
      ["a", "dest-a", a],
      ["b", "dest-b", b],
    ] as const) {
      loops.push(
        nats.consume(
          "STEELE_PUBLICATION",
          consumer,
          async (m) => {
            const decision = await handleApprovedArticle({
              payload: new TextDecoder().decode(m.data),
              destination,
              schedule: { delayMs: 0 },
              content,
              operations,
              owner: `test-${name}`,
              retryDelayMs: 500,
            });
            decisions[name].push(decision);
            await settle(m, decision);
          },
          abort.signal,
        ),
      );
    }
    const receipts = () =>
      Object.fromEntries(
        (["a", "b"] as const).map((n) => [
          n,
          decisions[n].filter((d) => d.action === "ack" && d.outcome === "delivered").length,
        ]),
      );
    await until("two receipts per destination", () => {
      const r = receipts();
      return r.a === 2 && r.b === 2 ? true : undefined;
    });
    expect(decisions.b.some((d) => d.action === "nak" && d.reason === "retry")).toBe(true);
    expect(a.deliveries).toHaveLength(2);
    expect(b.deliveries).toHaveLength(2);
    const saved = (await content.list("publications", 1_000)).filter((p) =>
      p.endsWith("receipt.json"),
    );
    expect(saved.filter((p) => p.startsWith("publications/site-a/"))).toHaveLength(2);
    expect(saved.filter((p) => p.startsWith("publications/site-b/"))).toHaveLength(2);

    // Replay a captured event: the bridge attaches to the existing run.
    expect(await handleCapturedContent(payloads[0], bridgeOptions)).toMatchObject({
      action: "ack",
      outcome: "already-running",
    });
    // Replay an approval: published again under a new message ID so JetStream
    // delivers it; each destination reuses its receipt.
    const pending = operations.pendingEvent(results[0].approvalEvent!)!;
    const before = { a: decisions.a.length, b: decisions.b.length };
    await nats.publish(ARTICLE_APPROVED_SUBJECT, new TextEncoder().encode(pending.payload), {
      msgId: `${pending.eventId}-replay`,
    });
    await until("both destinations handled the replay", () =>
      decisions.a.length > before.a && decisions.b.length > before.b ? true : undefined,
    );
    expect(decisions.a.at(-1)).toMatchObject({ action: "ack", outcome: "reused" });
    expect(decisions.b.at(-1)).toMatchObject({ action: "ack", outcome: "reused" });
    // Nothing was drafted or delivered twice.
    expect(a.deliveries).toHaveLength(2);
    expect(b.deliveries).toHaveLength(2);
    // A replay adds no generation draft and no second logical article.
    const after = await content.list("articles", 1_000);
    expect(
      after.filter(
        (p) => classifyArticlePath(p)?.kind === "legacy-generation" && p.endsWith(".md"),
      ),
    ).toHaveLength(draftCount);
    expect(
      after.filter(
        (p) => classifyArticlePath(p)?.kind === "canonical" && p.endsWith("/article.md"),
      ),
    ).toHaveLength(articleCount);
  });
});
