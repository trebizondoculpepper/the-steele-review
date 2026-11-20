import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  AnalysisFanOut,
  buildOccurrenceEvents,
  fanOutOperationKey,
} from "../../src/analysis/fan-out.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { DeliveredMessage } from "../../src/controllers/nats.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  CLAIM_OCCURRED_SUBJECT,
  parseClaimOccurredEvent,
} from "../../src/events/claim-occurred-event.js";
import {
  POST_ANALYSED_SUBJECT,
  createPostAnalysedEvent,
  type PostAnalysedData,
} from "../../src/events/post-analysed-event.js";
import {
  THEME_OCCURRED_SUBJECT,
  parseThemeOccurredEvent,
} from "../../src/events/theme-occurred-event.js";

const SOURCE_VERSION = `sha256:${"c".repeat(64)}`;
const post = { publicationId: "pub", postId: "p1" };
const sourceArtifact = {
  repository: "archive",
  commit: "a".repeat(40),
  path: "substack/pub/p1/collected.json",
  hash: `sha256:${"b".repeat(64)}`,
};
const themeId = `theme-${"1".repeat(24)}`;
const claimId = `claim-${"2".repeat(32)}`;

let dir: string;
let content: GitArtifactStore;
let operations: OperationStore;
let now: () => Date;
let clock: number;
let sequence = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-fan-out-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  clock = 1_760_000_000_000;
  operations = new OperationStore({ path: join(dir, "state.sqlite"), now: () => clock });
  now = () => new Date(clock);
  sequence = 0;
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

const themeResult = (over: { proposals?: unknown[] } = {}) => ({
  schemaVersion: 1,
  post: { sourceType: "substack", ...post },
  sourceVersion: SOURCE_VERSION,
  artifact: sourceArtifact,
  proposals: over.proposals ?? [{ id: themeId, title: "Geoengineering" }],
  rejected: [],
  catalogueContext: null,
  extraction: {
    schemaVersion: 1,
    modelVersion: "m",
    promptVersion: "theme-proposals-v2",
    proposedAt: "2026-01-01T00:00:00Z",
  },
});

const claimResult = (over: {
  post?: { publicationId: string; postId: string };
  schemaVersion?: 1 | 2;
  claims?: unknown[];
} = {}) => ({
  schemaVersion: over.schemaVersion ?? 2,
  post: over.post ?? post,
  sourceVersion: SOURCE_VERSION,
  themeIds: [themeId],
  themeResult: "", // filled by savePair
  claims: over.claims ?? [
    {
      claim: { statement: "Geoengineering has run for decades" },
      occurrence: { occurrenceId: "occ-p1-1", passage: "..." },
      kind: "assertion",
      themeIds: [themeId],
      classification: "themed",
      claimRecordId: claimId,
    },
  ],
  candidates: [],
  rejected: [],
  extraction: { modelVersion: "m", promptVersion: "claims-v2", extractedAt: "2026-01-01T00:00:00Z" },
});

async function savePair(
  theme: unknown,
  claims: (over?: unknown) => Record<string, unknown>,
  opts: { claimOverrides?: Parameters<typeof claimResult>[0]; themePath?: string; claimPath?: string } = {},
) {
  const n = ++sequence;
  const themeRef = await content.write(
    opts.themePath ?? `theme-proposals/pub/p1/one-${n}.json`,
    `${JSON.stringify(theme)}\n`,
  );
  const record = claims(opts.claimOverrides ?? {});
  record.themeResult = `${themeRef.commit}:${themeRef.path}`;
  const claimRef = await content.write(
    opts.claimPath ?? `claim-extractions/pub/p1/one-${n}.json`,
    `${JSON.stringify(record)}\n`,
  );
  return { themeRef, claimRef, record };
}

const asReference = (ref: {
  repository: string;
  commit: string;
  path: string;
  sha256: string;
}) => ({
  repository: ref.repository,
  commit: ref.commit,
  path: ref.path,
  hash: `sha256:${ref.sha256}`,
});

const parentData = (
  refs: { themeRef: { repository: string; commit: string; path: string; sha256: string }; claimRef: { repository: string; commit: string; path: string; sha256: string } },
): PostAnalysedData => ({
  ...post,
  sourceVersion: SOURCE_VERSION,
  sourceArtifact,
  themeResult: asReference(refs.themeRef),
  claimResult: asReference(refs.claimRef),
  themes: { model: "m", prompt: "theme-proposals-v2", schema: 1 },
  claims: { model: "m", prompt: "claims-v2", schema: 2 },
  counts: { themeProposals: 1, acceptedClaims: 1, candidates: 0, rejected: 0 },
});

function parentMessage(data: PostAnalysedData, id = "parent-event-1"): DeliveredMessage {
  const event = createPostAnalysedEvent(data, { id, now });
  const seen = { acked: 0, naked: 0, termed: 0 };
  return {
    data: new TextEncoder().encode(JSON.stringify(event.toJSON())),
    deliveryCount: 1,
    ack: async () => {
      seen.acked++;
    },
    nak: () => {
      seen.naked++;
    },
    term: () => {
      seen.termed++;
    },
    working: () => undefined,
    // Attached for assertions in tests that need it.
    ...({ seen } as object),
  } as DeliveredMessage & { seen: { acked: number; naked: number; termed: number } };
}

function publisher(fail = false) {
  const sent: Array<{ subject: string; msgId: string; payload: string }> = [];
  return {
    sent,
    async publish(subject: string, payload: Uint8Array, options: { msgId: string }) {
      if (fail) throw new Error("broker down");
      sent.push({ subject, msgId: options.msgId, payload: new TextDecoder().decode(payload) });
    },
  };
}

const worker = (pub: ReturnType<typeof publisher>) =>
  new AnalysisFanOut({
    content,
    operations,
    publisher: pub,
    owner: "test",
    now,
  });

describe("AnalysisFanOut", { timeout: 30_000 }, () => {
  it("records one theme and one claim occurrence with exact artifact references", async () => {
    const { themeRef, claimRef } = await savePair(themeResult(), claimResult);
    const pub = publisher();
    const message = parentMessage(parentData({ themeRef, claimRef }));
    expect(await worker(pub).handle(message)).toBe("fanned-out");

    expect(pub.sent.map((s) => s.subject)).toEqual([THEME_OCCURRED_SUBJECT, CLAIM_OCCURRED_SUBJECT]);
    const theme = parseThemeOccurredEvent(pub.sent[0].payload);
    expect(theme).toMatchObject({
      ...post,
      sourceVersion: SOURCE_VERSION,
      theme: { id: themeId, title: "Geoengineering" },
    });
    expect(theme.themeResult).toEqual(asReference(themeRef));
    expect(theme.claimResult).toEqual(asReference(claimRef));

    const claim = parseClaimOccurredEvent(pub.sent[1].payload);
    expect(claim).toMatchObject({
      ...post,
      occurrenceId: "occ-p1-1",
      claimId,
      kind: "assertion",
      themeIds: [themeId],
    });
    expect(claim.themeResult.path).toBe(themeRef.path);
    expect(claim.claimResult.path).toBe(claimRef.path);
    expect(message.ack).toBeTypeOf("function");
  });

  it("is idempotent for a duplicate parent delivery", async () => {
    const { themeRef, claimRef } = await savePair(themeResult(), claimResult);
    const data = parentData({ themeRef, claimRef });
    const pub = publisher();
    const fanOut = worker(pub);
    expect(await fanOut.handle(parentMessage(data))).toBe("fanned-out");
    const firstSends = pub.sent.length;

    expect(await fanOut.handle(parentMessage(data))).toBe("already-fanned-out");
    expect(pub.sent).toHaveLength(firstSends);
    expect(operations.pendingEventStatus(pub.sent[0].msgId)).toBe("sent");
  });

  it("keeps occurrence events pending across a publish failure and a restart", async () => {
    const { themeRef, claimRef } = await savePair(themeResult(), claimResult);
    const data = parentData({ themeRef, claimRef });
    const broken = publisher(true);
    expect(await worker(broken).handle(parentMessage(data))).toBe("fanned-out");
    const recorded = operations.operationStatus(fanOutOperationKey(data));
    expect(recorded?.status).toBe("completed");

    // A restarted worker drains the pending events without any parent
    // redelivery once the retry delay has elapsed.
    clock += 61_000;
    const pub = publisher();
    expect(await worker(pub).dispatchPending()).toBe(2);
    expect(pub.sent).toHaveLength(2);
    expect(new Set(pub.sent.map((s) => s.msgId)).size).toBe(2);
  });

  it("emits a separate claim occurrence for the same claim in a new post", async () => {
    const first = await savePair(themeResult(), claimResult);
    const pub = publisher();
    const fanOut = worker(pub);
    await fanOut.handle(parentMessage(parentData(first)));

    const otherPost = { publicationId: "pub", postId: "p2" };
    const secondTheme = await content.write(
      "theme-proposals/pub/p2/one.json",
      `${JSON.stringify({
        ...themeResult(),
        post: { sourceType: "substack", ...otherPost },
      })}\n`,
    );
    const secondClaimRecord = {
      ...claimResult({ post: otherPost }),
      themeResult: `${secondTheme.commit}:${secondTheme.path}`,
      claims: [
        {
          claim: { statement: "Geoengineering has run for decades" },
          occurrence: { occurrenceId: "occ-p2-1" },
          kind: "assertion",
          themeIds: [themeId],
          classification: "themed",
          claimRecordId: claimId,
        },
      ],
    };
    const secondClaim = await content.write(
      "claim-extractions/pub/p2/one.json",
      `${JSON.stringify(secondClaimRecord)}\n`,
    );
    const data2: PostAnalysedData = {
      ...parentData({ themeRef: secondTheme, claimRef: secondClaim }),
      ...otherPost,
    };
    expect(await fanOut.handle(parentMessage(data2, "parent-event-2"))).toBe("fanned-out");

    const claims = pub.sent
      .filter((s) => s.subject === CLAIM_OCCURRED_SUBJECT)
      .map((s) => parseClaimOccurredEvent(s.payload));
    expect(claims).toHaveLength(2);
    expect(claims[0].occurrenceId).not.toBe(claims[1].occurrenceId);
    expect(claims[0].claimId).toBe(claims[1].claimId);
  });

  it("records a valid zero-result analysis without events", async () => {
    const { themeRef, claimRef } = await savePair(
      themeResult({ proposals: [] }),
      claimResult,
      { claimOverrides: { claims: [] } },
    );
    const pub = publisher();
    const data = parentData({ themeRef, claimRef });
    expect(await worker(pub).handle(parentMessage(data))).toBe("fanned-out");
    expect(pub.sent).toEqual([]);
    expect(operations.operationStatus(fanOutOperationKey(data))?.status).toBe("completed");
  });

  it("refuses results that cannot complete an analysis and records no events", async () => {
    const legacy = await savePair(themeResult(), claimResult, {
      claimOverrides: { schemaVersion: 1 },
    });
    const pub = publisher();
    expect(await worker(pub).handle(parentMessage(parentData(legacy)))).toBe("refused");
    expect(pub.sent).toEqual([]);
    expect(operations.duePendingEvents(10)).toEqual([]);

    const mismatched = await savePair(themeResult(), claimResult, {
      claimOverrides: { post: { publicationId: "pub", postId: "other" } },
    });
    expect(await worker(pub).handle(parentMessage(parentData(mismatched)))).toBe("refused");
    expect(pub.sent).toEqual([]);
  });

  it("refuses when a referenced result is unreadable", async () => {
    const { themeRef, claimRef } = await savePair(themeResult(), claimResult);
    const data = parentData({ themeRef, claimRef });
    // Point the parent at a path that has no saved artifact.
    const missing: PostAnalysedData = {
      ...data,
      themeResult: { ...data.themeResult, path: "theme-proposals/pub/p1/missing.json" },
    };
    const pub = publisher();
    expect(await worker(pub).handle(parentMessage(missing))).toBe("refused");
    expect(pub.sent).toEqual([]);
  });

  it("bounds the operation key for long post identities", async () => {
    const longPost = { publicationId: "p".repeat(19), postId: "s".repeat(80) };
    const key = fanOutOperationKey({
      ...longPost,
      themeResult: {
        repository: "content",
        commit: "a".repeat(40),
        path: `theme-proposals/${longPost.publicationId}/${longPost.postId}/${"x".repeat(120)}.json`,
        hash: SOURCE_VERSION,
      },
      claimResult: {
        repository: "content",
        commit: "b".repeat(40),
        path: `claim-extractions/${longPost.publicationId}/${longPost.postId}/${"y".repeat(120)}.json`,
        hash: SOURCE_VERSION,
      },
    });
    expect(key.length).toBeLessThanOrEqual(512);
    // The controller must accept it: a rejected key would nak forever.
    expect(() =>
      operations.claim(key, "test", 60_000, 1),
    ).not.toThrow();
  });

  it("retries when an artifact read fails transiently", async () => {
    const { themeRef, claimRef } = await savePair(themeResult(), claimResult);
    const data = parentData({ themeRef, claimRef });
    const failing = {
      read: async () => {
        const { ArtifactStoreError } = await import("../../src/controllers/artifact-store.js");
        throw new ArtifactStoreError("git-failed");
      },
    };
    const fanOut = new AnalysisFanOut({
      content: failing as never,
      operations,
      publisher: publisher(),
      owner: "test",
      now,
    });
    let naked = false;
    const message = {
      ...parentMessage(data),
      nak: () => {
        naked = true;
      },
    } as DeliveredMessage;
    expect(await fanOut.handle(message)).toBe("retry");
    expect(naked).toBe(true);
    expect(operations.duePendingEvents(10)).toEqual([]);
    // The operation is not terminally failed: a later attempt can complete it.
    expect(operations.operationStatus(fanOutOperationKey(data))).toBeUndefined();
  });

  it("rejects a malformed parent event without acking it", async () => {
    const pub = publisher();
    const message = {
      data: new TextEncoder().encode("{not an event"),
      deliveryCount: 1,
      ack: async () => {
        throw new Error("must not ack");
      },
      nak: () => undefined,
      term: () => undefined,
      working: () => undefined,
    } satisfies DeliveredMessage;
    expect(await worker(pub).handle(message)).toBe("invalid-event");
  });
});

describe("buildOccurrenceEvents", () => {
  it("derives stable event IDs and ordered occurrences", async () => {
    const { themeRef, claimRef, record } = await savePair(themeResult(), claimResult);
    const input = {
      post,
      parentId: "parent-1",
      sourceVersion: SOURCE_VERSION,
      sourceArtifact,
      themeResult: asReference(themeRef),
      claimResult: asReference(claimRef),
      theme: themeResult() as never,
      claims: record as never,
      now,
    };
    const a = buildOccurrenceEvents(input);
    const b = buildOccurrenceEvents(input);
    expect(a.status).toBe("ok");
    expect(a.status === "ok" && a.events.map((e) => e.eventId)).toEqual(
      b.status === "ok" && b.events.map((e) => e.eventId),
    );
  });

  it("refuses claims without an occurrence identity", async () => {
    const { themeRef, claimRef, record } = await savePair(themeResult(), claimResult);
    const claims = {
      ...record,
      claims: [
        {
          claim: { statement: "x" },
          occurrence: { passage: "no id" },
          kind: "assertion",
          themeIds: [],
          classification: "themed",
        },
      ],
    };
    const built = buildOccurrenceEvents({
      post,
      parentId: "parent-1",
      sourceVersion: SOURCE_VERSION,
      sourceArtifact,
      themeResult: asReference(themeRef),
      claimResult: asReference(claimRef),
      theme: themeResult() as never,
      claims: claims as never,
      now,
    });
    expect(built).toEqual({ status: "refused", reason: "unidentified-claim-occurrence" });
  });
});

// Keep the unused-import check honest: the subject constant is part of the contract.
void POST_ANALYSED_SUBJECT;
