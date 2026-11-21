import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  announcePost,
  postAnalysedEventId,
  publishRecordedEvent,
} from "../../src/analysis/announce.js";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import { extractGroundedClaims } from "../../src/analysis/grounded-claims.js";
import {
  DEFAULT_THEME_PROPOSAL_PROMPT,
  proposeThemes,
} from "../../src/analysis/theme-proposals.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore, type ArtifactRef } from "../../src/controllers/artifact-store.js";
import { OperationStore } from "../../src/controllers/operation-store.js";
import {
  POST_ANALYSED_SUBJECT,
  parsePostAnalysedEvent,
} from "../../src/events/post-analysed-event.js";

const TEXT = "Geoengineering has run for decades. The bins were late.";
const post = { publicationId: "pub", postId: "p" };
const artifact = {
  repository: "archive",
  commit: "a".repeat(40),
  path: "substack/pub/p/collected.json",
  hash: `sha256:${"b".repeat(64)}`,
};

let dir: string;
let content: GitArtifactStore;
let operations: OperationStore;

const model = (...r: string[]): ExtractionModelProvider => ({
  modelVersion: "fake/m",
  async complete() {
    const next = r.shift();
    if (next === undefined) throw new Error("none");
    return next;
  },
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-announce-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  operations = new OperationStore({ path: join(dir, "analysis.sqlite") });
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

async function analyse(opts: { claims?: unknown[]; text?: string; postId?: string } = {}) {
  const text = opts.text ?? TEXT;
  const p = { ...post, postId: opts.postId ?? post.postId };
  const source = { text, sourceVersion: sourceVersionFor(text), artifact };
  const themes = await proposeThemes({
    provider: model('{"themes":[{"title":"Geoengineering"}]}'),
    artifacts: content,
    post: p,
    source,
  });
  if (themes.status !== "proposed") throw new Error(themes.status);
  const geo = themes.result.proposals[0].id;
  const claims = await extractGroundedClaims({
    provider: model(
      JSON.stringify({
        claims: opts.claims ?? [
          {
            statement: "Geoengineering has run for decades",
            claimType: "factual",
            kind: "assertion",
            passage: "Geoengineering has run for decades.",
            qualifiers: [],
            entities: [],
            dates: [],
            speaker: { kind: "author-voice" },
            themeIds: [geo],
          },
        ],
      }),
    ),
    artifacts: content,
    themes: [{ id: geo, name: "Geoengineering", definition: "Geoengineering" }],
    themeResult: `${themes.ref.commit}:${themes.ref.path}`,
    source: { ...source, ...p, url: `https://pub.example.com/p/${p.postId}` },
  });
  if (claims.status !== "extracted") throw new Error(claims.status);
  return { themeRef: themes.ref, claimRef: claims.recordRef };
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

const run = (refs: { themeRef: ArtifactRef; claimRef: ArtifactRef }, extra: object = {}) =>
  announcePost({ content, operations, post, owner: "test", ...refs, ...extra });

describe("announcePost", { timeout: 60_000 }, () => {
  it("records the event before publishing, then sends it once with a stable ID", async () => {
    const refs = await analyse();
    const pending = await run(refs);
    expect(pending).toMatchObject({ status: "recorded", newlyRecorded: true, delivery: "pending" });

    // Recording is separate from publication: a restart publishes the saved event.
    const pub = publisher();
    const eventId = postAnalysedEventId(refs.themeRef, refs.claimRef);
    expect(await publishRecordedEvent(operations, eventId, pub)).toBe("sent");
    expect(pub.sent).toHaveLength(1);
    expect(pub.sent[0].subject).toBe(POST_ANALYSED_SUBJECT);
    expect(pub.sent[0].msgId).toBe(eventId);
    const data = parsePostAnalysedEvent(pub.sent[0].payload);
    expect(data).toMatchObject({
      ...post,
      counts: { themeProposals: 1, acceptedClaims: 1, candidates: 0, rejected: 0 },
      themes: { prompt: DEFAULT_THEME_PROPOSAL_PROMPT.version, schema: 1 },
      claims: { schema: 3 },
    });

    // Identical rerun: one logical completion, nothing resent.
    const again = await run(refs);
    expect(again).toMatchObject({ newlyRecorded: false, delivery: "sent" });
    expect(await publishRecordedEvent(operations, eventId, pub)).toBe("sent");
    expect(pub.sent).toHaveLength(1);
  });

  it("keeps the event pending when publication fails", async () => {
    const refs = await analyse();
    const eventId = postAnalysedEventId(refs.themeRef, refs.claimRef);
    expect(await run(refs)).toMatchObject({ delivery: "pending" });
    expect(await publishRecordedEvent(operations, eventId, publisher(true))).toBe("pending");
    expect(operations.pendingEventStatus(eventId)).toBe("pending");
    expect(await publishRecordedEvent(operations, "no-such-event", publisher())).toBe("missing");
  });

  it("recovers the handoff after interrupted attempts exhausted the claim", async () => {
    const refs = await analyse();
    const eventId = postAnalysedEventId(refs.themeRef, refs.claimRef);
    const key = `analysed:${post.publicationId}/${post.postId}:${eventId}`;
    // Three interrupted attempts leave no completion record.
    for (let attempt = 0; attempt < 3; attempt++) {
      const claim = operations.claim(key, `interrupted-${attempt}`, 60_000, 3);
      if (claim.kind !== "claimed") throw new Error(`unexpected ${claim.kind}`);
      operations.fail(claim.claim, "interrupted", true);
    }
    // Both results are still valid, so the handoff is recorded atomically.
    const out = await run(refs);
    expect(out).toMatchObject({
      status: "recorded",
      eventId,
      newlyRecorded: true,
      delivery: "pending",
    });
    expect(operations.pendingEventStatus(eventId)).toBe("pending");
    // A repeat does not record it twice.
    expect(await run(refs)).toMatchObject({ status: "recorded", newlyRecorded: false });
  });

  it("publishes the recorded event even when a backlog fills the due page", async () => {
    // 1,000 older due events fill the oldest-first page the old lookup used.
    const backlog = operations.claim("announced:backlog", "test", 60_000);
    if (backlog.kind !== "claimed") throw new Error("unexpected claim");
    operations.complete(
      backlog.claim,
      { eventId: "backlog" },
      Array.from({ length: 1_000 }, (_, n) => ({
        eventId: `backlog-${n}`,
        subject: POST_ANALYSED_SUBJECT,
        payload: "{}",
      })),
    );
    const refs = await analyse();
    const eventId = postAnalysedEventId(refs.themeRef, refs.claimRef);
    expect(await run(refs)).toMatchObject({ status: "recorded", delivery: "pending" });
    expect(
      operations.duePendingEvents(1_000, POST_ANALYSED_SUBJECT).map((e) => e.eventId),
    ).not.toContain(eventId);
    const pub = publisher();
    expect(await publishRecordedEvent(operations, eventId, pub)).toBe("sent");
    expect(pub.sent.map((s) => s.msgId)).toEqual([eventId]);
  });

  it("completes a valid empty result", async () => {
    const refs = await analyse({ claims: [] });
    const out = await run(refs);
    expect(out.status === "recorded" && out.data.counts.acceptedClaims).toBe(0);
  });

  it("refuses mismatched, unlinked, legacy and unreadable results", async () => {
    const a = await analyse();
    const b = await analyse({ postId: "q" });
    // Theme result from another post.
    expect(await run({ themeRef: b.themeRef, claimRef: a.claimRef })).toMatchObject({
      status: "refused",
    });
    // Claim result for this post that links a different theme result.
    const other = await analyse({ text: "Other text entirely." });
    expect(await run({ themeRef: a.themeRef, claimRef: other.claimRef })).toMatchObject({
      status: "refused",
      reason: "source-version-mismatch",
    });
    // Unreadable.
    const broken = await content.write("claim-extractions/pub/p/broken.json", "{not json");
    expect(await run({ themeRef: a.themeRef, claimRef: broken })).toMatchObject({
      reason: "unreadable-claim-result",
    });
    // Legacy v1 record.
    const legacy = await content.write(
      "claim-extractions/pub/p/legacy.json",
      JSON.stringify({
        schemaVersion: 1,
        post,
        sourceVersion: sourceVersionFor(TEXT),
        themeIds: [],
        claims: [],
        rejected: [],
        extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    expect(await run({ themeRef: a.themeRef, claimRef: legacy })).toMatchObject({
      reason: "legacy-claim-result",
    });
    expect(operations.duePendingEvents(100, POST_ANALYSED_SUBJECT)).toEqual([]);
  });

  it("gives a changed claim or theme result a different event", async () => {
    const a = await analyse();
    const changed = await analyse({ text: "Geoengineering has run for decades. Something new." });
    expect(postAnalysedEventId(a.themeRef, a.claimRef)).not.toBe(
      postAnalysedEventId(changed.themeRef, changed.claimRef),
    );
  });
});
