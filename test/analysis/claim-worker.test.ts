import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  CLAIMS_EXTRACTED_SUBJECT,
  ClaimExtractionWorker,
  ClaimsExtractedDataSchema,
} from "../../src/analysis/claim-worker.js";
import { ClaimExtractor, type ExtractionModelProvider } from "../../src/analysis/extraction.js";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import { createTextReadyEvent } from "../../src/events/text-ready-event.js";

const TEXT = "The synthetic council raised fees by 3% last spring. A critic called it unfair.";
const item = {
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  title: "A synthetic post",
};
const record = (complete = true): CollectionRecord => ({
  item,
  ingestionReason: "backfill",
  text: TEXT,
  complete,
  supplied: {},
  provenance: {
    sourceUrl: item.url,
    acquiredAt: "2026-02-01T00:00:00.000Z",
    method: "supplied-transcript",
  },
});
const goodClaims = JSON.stringify({
  claims: [
    {
      statement: "The synthetic council raised fees by 3% last spring.",
      claimType: "factual",
      passage: "The synthetic council raised fees by 3% last spring.",
      dates: [{ text: "last spring" }],
    },
  ],
});

let dir: string;
let artifacts: GitArtifactStore;
let operations: OperationStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-claim-worker-"));
  await mkdir(join(dir, "archive"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "test-archive" });
  await artifacts.initialise();
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

async function message(r = record(), path = "substack/example-pub/a-post/collected.json") {
  const ref = await artifacts.write(path, `${JSON.stringify(r)}\n`);
  const event = createTextReadyEvent({
    publicationId: item.publicationId,
    postId: item.postId,
    url: item.url,
    ingestionReason: "backfill",
    artifact: {
      repository: ref.repository,
      commit: ref.commit,
      path: ref.path,
      hash: `sha256:${ref.sha256}`,
    },
    acquisitionMethod: "supplied-transcript",
    complete: r.complete,
  });
  const m = {
    data: new TextEncoder().encode(JSON.stringify(event.toJSON())),
    deliveryCount: 1,
    acks: 0,
    naks: [] as number[],
    terms: 0,
    ack: async () => {
      m.acks++;
    },
    nak: (d?: number) => {
      m.naks.push(d ?? 0);
    },
    term: () => {
      m.terms++;
    },
    working: () => {},
  };
  return m as DeliveredMessage & typeof m;
}

function setup(responses: Array<string | Error>, publishFails = 0) {
  const calls: number[] = [];
  const provider: ExtractionModelProvider = {
    modelVersion: "fake/claims-1",
    async complete() {
      calls.push(1);
      const next = responses.shift();
      if (next === undefined) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const published: Array<{ subject: string; body: string; msgId: string }> = [];
  let failures = publishFails;
  const worker = new ClaimExtractionWorker({
    extractor: new ClaimExtractor({
      provider,
      maxAttempts: 1,
      now: () => new Date("2026-03-01T00:00:00Z"),
    }),
    modelVersion: "fake/claims-1",
    promptVersion: "claim-extraction-v1",
    artifacts,
    operations,
    publisher: {
      publish: async (subject, payload, { msgId }) => {
        if (failures-- > 0) throw new Error("broker down");
        published.push({ subject, body: new TextDecoder().decode(payload), msgId });
      },
    },
    owner: "claim-worker",
    retryDelayMs: 0,
  });
  return { worker, published, calls };
}

describe("ClaimExtractionWorker", () => {
  it("extracts, stores the claim set, acknowledges and hands off", async () => {
    const { worker, published } = setup([goodClaims]);
    const m = await message();
    expect(await worker.handle(m)).toBe("extracted");
    expect(m.acks).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]!.subject).toBe(CLAIMS_EXTRACTED_SUBJECT);
    const data = ClaimsExtractedDataSchema.parse(JSON.parse(published[0]!.body).data);
    expect(data).toMatchObject({ status: "complete", claimCount: 1, ingestionReason: "backfill" });
    const stored = JSON.parse(
      await artifacts.read({
        repository: data.claimsArtifact.repository,
        commit: data.claimsArtifact.commit,
        path: data.claimsArtifact.path,
        sha256: data.claimsArtifact.hash.slice(7),
      }),
    );
    expect(stored.claims[0].dates).toEqual([{ text: "last spring" }]);
  });

  it("deduplicates duplicate events by source, model and prompt version", async () => {
    const { worker, calls, published } = setup([goodClaims]);
    const first = await message();
    const duplicate = await message(record(), "substack/example-pub/a-post/copy.json");
    expect(await worker.handle(first)).toBe("extracted");
    expect(await worker.handle(duplicate)).toBe("already-extracted");
    expect(duplicate.acks).toBe(1);
    expect(calls).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("extracts identical text in two different posts separately", async () => {
    const { worker, calls, published } = setup([goodClaims, goodClaims]);
    expect(await worker.handle(await message())).toBe("extracted");
    const otherPost = {
      ...record(),
      item: { ...item, postId: "b-post", url: "https://example-pub.substack.com/p/b-post" },
    };
    const ref = await artifacts.write(
      "substack/example-pub/b-post/collected.json",
      `${JSON.stringify(otherPost)}\n`,
    );
    const event = createTextReadyEvent({
      publicationId: "example-pub",
      postId: "b-post",
      url: "https://example-pub.substack.com/p/b-post",
      ingestionReason: "live",
      artifact: {
        repository: ref.repository,
        commit: ref.commit,
        path: ref.path,
        hash: `sha256:${ref.sha256}`,
      },
      acquisitionMethod: "supplied-transcript",
      complete: true,
    });
    const m = await message();
    m.data = new TextEncoder().encode(JSON.stringify(event.toJSON()));
    expect(await worker.handle(m)).toBe("extracted");
    expect(calls).toHaveLength(2);
    expect(published.map((p) => JSON.parse(p.body).data.postId)).toEqual(["a-post", "b-post"]);
  });

  it("finishes from a claim set committed by a final attempt that crashed", async () => {
    // First run commits and completes; then simulate the crash by marking the
    // operation exhausted without completion and running again.
    const { worker, published } = setup([goodClaims]);
    expect(await worker.handle(await message())).toBe("extracted");
    const [first] = published.splice(0);
    const key = [
      ...(
        operations as unknown as { db: { prepare(s: string): { all(): Array<{ key: string }> } } }
      ).db
        .prepare("SELECT key FROM operations WHERE key LIKE 'claims:%'")
        .all(),
    ][0]!.key;
    (operations as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE operations SET status = 'failed', artifact = NULL WHERE key = ?")
      .run(key);
    const again = setup([]);
    const m = await message(record(), "substack/example-pub/a-post/again.json");
    expect(await again.worker.handle(m)).toBe("already-extracted");
    expect(m.acks).toBe(1);
    expect(operations.claim(key, "x", 1_000).kind).toBe("completed");
    expect(again.calls).toHaveLength(0);
    expect(JSON.parse(again.published[0]!.body).data.claimsArtifact).toEqual(
      JSON.parse(first!.body).data.claimsArtifact,
    );
  });

  it("stores schema-rejected claims as an explicit incomplete result", async () => {
    const invented = JSON.stringify({
      claims: [
        JSON.parse(goodClaims).claims[0],
        {
          statement: "Invented.",
          claimType: "factual",
          passage: "This sentence is not in the source.",
        },
      ],
    });
    const { worker, published } = setup([invented]);
    expect(await worker.handle(await message())).toBe("extracted");
    const data = ClaimsExtractedDataSchema.parse(JSON.parse(published[0]!.body).data);
    expect(data).toMatchObject({ status: "incomplete", claimCount: 1 });
  });

  it("retries transient extraction failures and records nothing as complete", async () => {
    const { worker } = setup([new Error("provider down")]);
    const m = await message();
    expect(await worker.handle(m)).toBe("retry");
    expect(m.acks).toBe(0);
    expect(m.naks).toHaveLength(1);
  });

  it("keeps the handoff pending when publishing fails and retries it with the same ID", async () => {
    const { worker, published } = setup([goodClaims], 1);
    const m = await message();
    expect(await worker.handle(m)).toBe("extracted");
    expect(m.acks).toBe(1);
    expect(published).toHaveLength(0);
    const [pending] = operations.duePendingEvents();
    expect(await worker.dispatchPending()).toBe(1);
    expect(published[0]!.msgId).toBe(pending!.eventId);
  });

  it("dispatches its own pending events even behind another subject's backlog", async () => {
    for (let i = 0; i < 3; i++) {
      operations.recordPermanentFailure(`other:${i}`, "x");
      const c = operations.claim(`other-op:${i}`, "o", 1_000);
      if (c.kind === "claimed") {
        operations.complete(c.claim, {}, [
          { eventId: `other-${i}`, subject: "steele.v1.other", payload: "{}" },
        ]);
      }
    }
    const { worker, published } = setup([goodClaims], 1);
    await worker.handle(await message());
    expect(await worker.dispatchPending(2)).toBe(1);
    expect(published.map((p) => p.subject)).toEqual([CLAIMS_EXTRACTED_SUBJECT]);
  });

  it("keeps the committed claim set's source reference when recovering", async () => {
    const { worker, published } = setup([goodClaims]);
    await worker.handle(await message());
    const originalSource = JSON.parse(published[0]!.body).data.sourceArtifact;
    const key = (
      operations as unknown as { db: { prepare(s: string): { all(): Array<{ key: string }> } } }
    ).db
      .prepare("SELECT key FROM operations WHERE key LIKE 'claims:%'")
      .all()[0]!.key;
    (operations as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE operations SET status = 'failed' WHERE key = ?")
      .run(key);
    const again = setup([]);
    // Redelivered event points at a different archive copy of the same record.
    await again.worker.handle(
      await message(record(), "substack/example-pub/a-post/elsewhere.json"),
    );
    expect(JSON.parse(again.published[0]!.body).data.sourceArtifact).toEqual(originalSource);
  });

  it("retries rather than acknowledging exhaustion when the archive lookup fails", async () => {
    const { worker } = setup([goodClaims]);
    await worker.handle(await message());
    const db = (
      operations as unknown as {
        db: { prepare(s: string): { run(...a: unknown[]): void; all(): Array<{ key: string }> } };
      }
    ).db;
    const key = db.prepare("SELECT key FROM operations WHERE key LIKE 'claims:%'").all()[0]!.key;
    db.prepare("UPDATE operations SET status = 'failed' WHERE key = ?").run(key);
    const again = setup([]);
    artifacts.lookup = async () => {
      throw new Error("git unavailable");
    };
    const m = await message(record(), "substack/example-pub/a-post/retry.json").catch(
      () => undefined,
    );
    // message() itself writes through artifacts.write, which is unaffected.
    expect(m).toBeDefined();
    expect(await again.worker.handle(m!)).toBe("retry");
    expect(m!.acks).toBe(0);
    expect(m!.naks).toHaveLength(1);
  });

  it("records incomplete sources without extracting", async () => {
    const { worker, calls } = setup([goodClaims]);
    const m = await message(record(false));
    expect(await worker.handle(m)).toBe("incomplete-source");
    expect(m.acks).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("terminates malformed events", async () => {
    const { worker } = setup([]);
    const m = await message();
    m.data = new TextEncoder().encode("{}");
    expect(await worker.handle(m)).toBe("invalid-event");
    expect(m.terms).toBe(1);
  });
});
