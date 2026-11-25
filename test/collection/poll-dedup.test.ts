import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { CollectionStore } from "../../src/collection/collection-store.js";
import { requestReingest } from "../../src/collection/reingest.js";
import { CollectionWorker } from "../../src/collection/worker.js";
import type { SubstackItem } from "../../src/content/substack-item.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import type { CollectionResult } from "../../src/controllers/substack/collect.js";
import { runDiscovery } from "../../src/discovery/run.js";
import { CAPTURED_CONTENT_SUBJECT } from "../../src/events/captured-content-event.js";
import { createDiscoveryEvent, serializeDiscoveryEvent } from "../../src/events/discovery-event.js";
import { handleCapturedContent } from "../../src/workflow/captured-bridge.js";

/**
 * #867: recurring polls through discovery, collection, source-ready events
 * and automatic article runs, on synthetic fixtures. Each stage is counted
 * for a repeated feed entry, an edit to the same post, a genuinely new post,
 * an explicit resend, and a repeated deliberate rerun request. No network,
 * broker, Restate or model calls: the submitter deduplicates by workflow key
 * the way Restate does.
 */

const post = (slug: string): SubstackItem => ({
  publicationId: "example-pub",
  postId: slug,
  url: `https://example-pub.substack.com/p/${slug}`,
  title: `Post ${slug}`,
});
const NAMESPACE = "substack/example-pub";

let dir: string;
let operations: OperationStore;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "poll-dedup-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "archive" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const message = (payload: string): DeliveredMessage =>
  ({
    data: new TextEncoder().encode(payload),
    deliveryCount: 1,
    ack: async () => undefined,
    nak: () => undefined,
    term: () => undefined,
    working: () => undefined,
  }) as DeliveredMessage;

function pipeline() {
  /** The text the source currently serves for each post. */
  const source = new Map<string, string>();
  let fetches = 0;
  const sourceReady: { id: string; payload: string }[] = [];
  const worker = new CollectionWorker({
    store: new CollectionStore(operations, artifacts),
    operations,
    collector: {
      collect: async (item): Promise<CollectionResult> => {
        fetches++;
        const text = source.get(item.postId)!;
        return {
          kind: "text",
          item,
          supplied: { articleHtml: `<p>${text}</p>` },
          text,
          complete: true,
          provenance: {
            sourceUrl: item.url,
            acquiredAt: new Date().toISOString(),
            method: "article-html",
          },
        };
      },
    },
    publisher: {
      publish: async (subject, payload, { msgId }) => {
        if (subject === CAPTURED_CONTENT_SUBJECT)
          sourceReady.push({ id: msgId, payload: new TextDecoder().decode(payload) });
      },
    },
    owner: "worker-1",
    retryDelayMs: 0,
  });
  /** Restate's behaviour: one workflow per key; a repeated key attaches. */
  const runs = new Set<string>();
  const submit = async (key: string) => {
    if (runs.has(key)) return "already-running" as const;
    runs.add(key);
    return "started" as const;
  };
  /** Each source-ready event is delivered to the bridge once, as JetStream would. */
  let bridged = 0;
  const bridge = async () => {
    for (; bridged < sourceReady.length; bridged++) {
      await handleCapturedContent(sourceReady[bridged]!.payload, {
        enabledSources: new Set([NAMESPACE]),
        researchDeadlineMs: 60_000,
        submit,
      });
    }
  };
  /** One poll: discovery publishes, collection consumes, the bridge admits. */
  const poll = async (feed: string[]) => {
    const discovered: string[] = [];
    await runDiscovery({
      source: (async function* () {
        for (const slug of feed) yield post(slug);
      })(),
      reason: "live",
      createEvent: (item, options) => createDiscoveryEvent(item, options),
      publisher: {
        publish: async (event) => {
          discovered.push(event.id);
          await worker.handle(message(serializeDiscoveryEvent(event)));
        },
      },
    });
    await worker.dispatchPending(new AbortController().signal);
    await bridge();
    return discovered.length;
  };
  const counts = () => ({
    fetches,
    sourceReady: new Set(sourceReady.map((e) => e.id)).size,
    runs: runs.size,
  });
  return { source, poll, worker, bridge, sourceReady, counts };
}

const commits = (path: string) =>
  Number(
    execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD", "--", path]).toString().trim(),
  );

describe("recurring polls discover new posts and suppress repeats (#867)", () => {
  it("counts each stage across initial, repeated, edited and new entries", async () => {
    const p = pipeline();
    p.source.set("one", "First post text.");
    p.source.set("two", "Second post text.");

    // Initial poll: two entries, two captures, two source-ready events, two runs.
    expect(await p.poll(["one", "two"])).toBe(2);
    expect(p.counts()).toEqual({ fetches: 2, sourceReady: 2, runs: 2 });

    // Unchanged repeat: the feed lists both again. Discovery republishes them,
    // collection suppresses them (no fetch, no event, no capture commit).
    expect(await p.poll(["one", "two"])).toBe(2);
    expect(p.counts()).toEqual({ fetches: 2, sourceReady: 2, runs: 2 });
    expect(commits("substack/example-pub/one/collected.json")).toBe(1);

    // An edit to the same post, seen by a later poll: rediscovery does not
    // refetch an already collected post, so no new capture and no new run.
    p.source.set("one", "First post text, edited.");
    await p.poll(["one", "two"]);
    expect(p.counts()).toEqual({ fetches: 2, sourceReady: 2, runs: 2 });

    // A genuinely new post flows through to exactly one new run.
    p.source.set("three", "Third post text.");
    expect(await p.poll(["three", "one", "two"])).toBe(3);
    expect(p.counts()).toEqual({ fetches: 3, sourceReady: 3, runs: 3 });
  });

  it("keeps event identity on an explicit resend, and admits no second run", async () => {
    const p = pipeline();
    p.source.set("one", "First post text.");
    await p.poll(["one"]);
    const [first] = p.sourceReady;
    // Resend: the same source-ready event, delivered again.
    p.sourceReady.push({ ...first! });
    await p.bridge();
    expect(p.sourceReady[1]!.id).toBe(first!.id);
    expect(p.counts()).toEqual({ fetches: 1, sourceReady: 1, runs: 1 });
  });

  it("revises an edit only through an explicit request, and a repeated request does nothing", async () => {
    const p = pipeline();
    p.source.set("one", "First post text.");
    await p.poll(["one"]);
    p.source.set("one", "First post text, edited.");

    const ask = () => requestReingest({ operations, item: post("one"), requestId: "edit-1" });
    expect(ask()).toMatchObject({ outcome: "requested" });
    expect(ask()).toMatchObject({ outcome: "already-requested" });
    const due = operations.duePendingEvents(10).filter((e) => e.eventId.startsWith("reingest-"));
    expect(due).toHaveLength(1);
    await p.worker.handle(message(due[0]!.payload));
    await p.worker.handle(message(due[0]!.payload)); // redelivery of the same request
    await p.worker.dispatchPending(new AbortController().signal);
    await p.bridge();

    // One refetch and one revision at the same path; the revised capture is
    // announced, but as a reprocess, so it starts no automatic run.
    expect(p.counts()).toEqual({ fetches: 2, sourceReady: 2, runs: 1 });
    expect(commits("substack/example-pub/one/collected.json")).toBe(2);
  });
});
