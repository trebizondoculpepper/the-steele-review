import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  captureSource,
  dispatchPendingSources,
  resendSource,
} from "../../src/capture/source-capture.js";
import { CollectionRecordSchema, CollectionStore } from "../../src/collection/collection-store.js";
import { requestReingest } from "../../src/collection/reingest.js";
import { CollectionWorker } from "../../src/collection/worker.js";
import type { SubstackItem } from "../../src/content/substack-item.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import type { CollectionResult } from "../../src/controllers/substack/collect.js";
import {
  CAPTURED_CONTENT_SUBJECT,
  parseCapturedContentEvent,
} from "../../src/events/captured-content-event.js";
import { createDiscoveryEvent, serializeDiscoveryEvent } from "../../src/events/discovery-event.js";
import { handleCapturedContent } from "../../src/workflow/captured-bridge.js";

/**
 * #868: the existing collector and the composable capture block (#865) on
 * identical synthetic inputs, each in its own isolated archive and state.
 * Durable results, source-ready events and the bridge's decisions are
 * compared; intentional differences are asserted explicitly.
 */

const post = (slug: string): SubstackItem => ({
  publicationId: "example-pub",
  postId: slug,
  url: `https://example-pub.substack.com/p/${slug}`,
  title: `Post ${slug}`,
});
const PREVIEW = {
  url: "https://substackcdn.example/image/upload/cover.png",
  source: "cover_image" as const,
  kind: "uploaded" as const,
};
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** The source as both paths see it: text and whether the image can be fetched. */
const world = { text: new Map<string, string>(), imageOk: true };
const collector = {
  collect: async (item: SubstackItem): Promise<CollectionResult> => ({
    kind: "text",
    item,
    supplied: { articleHtml: `<p>${world.text.get(item.postId)}</p>` },
    text: world.text.get(item.postId)!,
    complete: true,
    previewImage: PREVIEW,
    provenance: {
      sourceUrl: item.url,
      acquiredAt: new Date().toISOString(),
      method: "article-html",
    },
  }),
};
const images = {
  fetch: async () => {
    if (!world.imageOk) throw new Error("synthetic 404");
    return { bytes: PNG, contentType: "image/png" as const };
  },
};

let root: string;
const opened: OperationStore[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "capture-parity-"));
  world.text.clear();
  world.imageOk = true;
});
afterEach(async () => {
  for (const o of opened.splice(0)) o.close();
  await rm(root, { recursive: true, force: true });
});

async function side(name: string) {
  await mkdir(join(root, name));
  const artifacts = new GitArtifactStore({ repoPath: join(root, name), repository: "archive" });
  await artifacts.initialise();
  const operations = new OperationStore({ path: join(root, `${name}.sqlite`) });
  opened.push(operations);
  const events: string[] = [];
  const ids: string[] = [];
  let failNext = false;
  /** Like JetStream: deduplicates by message ID, the event's identity. */
  const publisher = {
    publish: async (subject: string, payload: Uint8Array, { msgId }: { msgId: string }) => {
      if (subject !== CAPTURED_CONTENT_SUBJECT) return;
      if (failNext) {
        failNext = false;
        throw new Error("synthetic broker outage");
      }
      if (ids.includes(msgId)) return;
      ids.push(msgId);
      events.push(new TextDecoder().decode(payload));
    },
  };
  return { artifacts, operations, events, publisher, fail: () => (failNext = true) };
}

const message = (payload: string) =>
  ({
    data: new TextEncoder().encode(payload),
    deliveryCount: 1,
    ack: async () => undefined,
    nak: () => undefined,
    term: () => undefined,
    working: () => undefined,
  }) as DeliveredMessage;

async function legacy() {
  const s = await side("legacy");
  const worker = new CollectionWorker({
    store: new CollectionStore(s.operations, s.artifacts),
    operations: s.operations,
    collector,
    publisher: s.publisher,
    owner: "worker-1",
    retryDelayMs: 0,
    imageRetention: { fetcher: images, artifacts: s.artifacts },
  });
  const capture = async (item: SubstackItem) => {
    await worker.handle(
      message(serializeDiscoveryEvent(createDiscoveryEvent(item, { reason: "live" }))),
    );
    await worker.dispatchPending(new AbortController().signal);
  };
  return { ...s, worker, capture };
}

async function block() {
  const s = await side("block");
  const deps = {
    collector,
    artifacts: s.artifacts,
    operations: s.operations,
    publisher: s.publisher,
    images,
    retryDelayMs: 0,
  };
  return {
    ...s,
    deps,
    capture: (item: SubstackItem) => captureSource(item, deps, { reason: "live" }),
  };
}

/** What both paths must agree on, minus the intentionally different file path. */
async function comparable(artifacts: GitArtifactStore, payload: string) {
  const event = parseCapturedContentEvent(payload);
  // The event ID is derived from the saved file's path and hash, which differ by design.
  const { artifact, eventId: _id, ...data } = event as typeof event & { eventId?: string };
  const record = CollectionRecordSchema.parse(
    JSON.parse(await artifacts.read({ ...artifact, sha256: artifact.hash.slice(7) } as never)),
  );
  return {
    event: { ...data, type: "captured" },
    record: {
      item: record.item,
      text: record.text,
      complete: record.complete,
      supplied: record.supplied,
      preview: record.previewImage
        ? { url: record.previewImage.url, retained: record.previewImage.retained?.artifact.path }
        : undefined,
      method: record.provenance.method,
    },
  };
}

const commits = (repo: string, path: string) =>
  Number(
    execFileSync("git", ["-C", repo, "rev-list", "--count", "HEAD", "--", path]).toString().trim(),
  );

describe("source capture parity: existing collector vs composable block (#868)", () => {
  it("captures a new source identically, apart from the file name", async () => {
    world.text.set("one", "First post text.");
    const old = await legacy();
    const neu = await block();
    await old.capture(post("one"));
    await neu.capture(post("one"));
    expect(old.events).toHaveLength(1);
    expect(neu.events).toHaveLength(1);
    expect(await comparable(neu.artifacts, neu.events[0]!)).toEqual(
      await comparable(old.artifacts, old.events[0]!),
    );
    // Intentional difference: one stable file per source, beside the old one's name.
    expect(parseCapturedContentEvent(old.events[0]!).artifact.path).toBe(
      "substack/example-pub/one/collected.json",
    );
    expect(parseCapturedContentEvent(neu.events[0]!).artifact.path).toBe(
      "substack/example-pub/one/source.json",
    );
  });

  it("makes no content change and no event for an unchanged refetch on either path", async () => {
    world.text.set("one", "Same text.");
    const old = await legacy();
    const neu = await block();
    for (let i = 0; i < 2; i++) {
      await old.capture(post("one"));
      await neu.capture(post("one"));
    }
    expect(old.events).toHaveLength(1);
    expect(neu.events).toHaveLength(1);
    expect(commits(join(root, "legacy"), "substack/example-pub/one/collected.json")).toBe(1);
    expect(commits(join(root, "block"), "substack/example-pub/one/source.json")).toBe(1);
  });

  it("revises a changed source at its stable path, by request on the old path and on refetch on the new", async () => {
    world.text.set("one", "Before the edit.");
    const old = await legacy();
    const neu = await block();
    await old.capture(post("one"));
    await neu.capture(post("one"));
    world.text.set("one", "After the edit.");
    // Intentional difference: the old collector does not refetch a collected
    // post on rediscovery; only a deliberate reingestion revises it.
    await old.capture(post("one"));
    expect(old.events).toHaveLength(1);
    requestReingest({ operations: old.operations, item: post("one"), requestId: "edit-1" });
    const due = old.operations
      .duePendingEvents(10)
      .filter((e) => e.eventId.startsWith("reingest-"));
    await old.worker.handle(message(due[0]!.payload));
    await old.worker.dispatchPending(new AbortController().signal);
    await neu.capture(post("one"));
    expect(old.events).toHaveLength(2);
    expect(neu.events).toHaveLength(2);
    const [o, n] = [
      await comparable(old.artifacts, old.events[1]!),
      await comparable(neu.artifacts, neu.events[1]!),
    ];
    expect(n.record).toEqual(o.record);
    // Intentional difference: the old path announces a reingestion as reprocess.
    expect(o.event.ingestionReason).toBe("reprocess");
    expect(n.event.ingestionReason).toBe("live");
    expect({ ...n.event, ingestionReason: "x" }).toEqual({ ...o.event, ingestionReason: "x" });
    expect(commits(join(root, "legacy"), "substack/example-pub/one/collected.json")).toBe(2);
    expect(commits(join(root, "block"), "substack/example-pub/one/source.json")).toBe(2);
  });

  it("saves the source without the image when it cannot be fetched, on both paths", async () => {
    world.text.set("one", "Text with a broken image.");
    world.imageOk = false;
    const old = await legacy();
    const neu = await block();
    await old.capture(post("one"));
    await neu.capture(post("one"));
    const [o, n] = [
      await comparable(old.artifacts, old.events[0]!),
      await comparable(neu.artifacts, neu.events[0]!),
    ];
    expect(o.record.preview).toEqual({ url: PREVIEW.url, retained: undefined });
    expect(n.record).toEqual(o.record);
  });

  it("recovers after save but before emission with the same event, on both paths", async () => {
    world.text.set("one", "Saved, then the broker failed.");
    const old = await legacy();
    const neu = await block();
    old.fail();
    neu.fail();
    await old.capture(post("one"), false);
    await neu.capture(post("one"));
    // The new block leaves the failed announcement pending. The old worker
    // already retries its outbox within the same handling call.
    expect(neu.events).toHaveLength(0);
    await old.worker.dispatchPending(new AbortController().signal);
    await dispatchPendingSources(neu.deps, post("one"));
    // Both end with exactly one source-ready event: recovered, not duplicated.
    expect([old.events.length, neu.events.length]).toEqual([1, 1]);
    // An explicit resend on the new path keeps the same event identity.
    const resent = await resendSource(post("one"), neu.deps);
    expect(resent).toMatchObject({ eventId: JSON.parse(neu.events[0]!).id });
    expect(neu.events).toHaveLength(1);
  });

  it("drives the same downstream run, and applies the approved admission change", async () => {
    world.text.set("one", "First post text.");
    world.text.set("two", "Second post text.");
    const old = await legacy();
    const neu = await block();
    for (const p of ["one", "two"]) {
      await old.capture(post(p));
      await neu.capture(post(p));
    }
    const submitted: Record<string, string[]> = { old: [], neu: [] };
    const bridgeState = new OperationStore({ path: join(root, "bridge.sqlite") });
    opened.push(bridgeState);
    const deliver = (who: "old" | "neu", payload: string, admit = false) =>
      handleCapturedContent(payload, {
        enabledSources: new Set(["substack/example-pub"]),
        researchDeadlineMs: 60_000,
        ...(admit ? { admit: (p) => bridgeState.admitAutomaticArticle(p) } : {}),
        submit: async (key) => {
          submitted[who]!.push(key);
          return "started";
        },
      });
    // Both paths lead to the same ArticleRun keys for the same sources.
    for (const e of old.events) await deliver("old", e);
    for (const e of neu.events) await deliver("neu", e);
    expect(submitted.neu).toEqual(submitted.old);

    // Approved change (#874): one automatic run per publisher post ID.
    submitted.neu = [];
    for (const e of neu.events) await deliver("neu", e, true);
    expect(submitted.neu).toHaveLength(2); // a new publisher ID is admitted
    world.text.set("one", "First post text, edited.");
    await neu.capture(post("one"));
    expect(await deliver("neu", neu.events.at(-1)!, true)).toMatchObject({
      reason: "already-admitted",
    });
    // An explicit rerun retried twice pins one exact saved input.
    const rerun = {
      publicationId: "example-pub",
      postId: "one",
      sourceVersion: parseCapturedContentEvent(neu.events.at(-1)!).sourceVersion,
      requestId: "owner-rerun-1",
      inputHash: "e".repeat(64),
    };
    const first = bridgeState.recordArticleAttempt(rerun);
    const again = bridgeState.recordArticleAttempt(rerun);
    expect(again).toEqual(first);
    expect(first.sourceVersion).toBe(rerun.sourceVersion);
    expect(bridgeState.automaticAdmission("example-pub", "one")?.revision).toBe(
      parseCapturedContentEvent(neu.events[0]!).sourceVersion.slice(7, 39),
    );
  });
});
