import { describe, expect, it } from "vite-plus/test";
import { normalisedClaimKey, type ClaimOccurrence } from "../../src/analysis/claim-occurrence.js";
import type { OccurrenceSearchPort } from "../../src/analysis/claim-timeline.js";
import { findCrossSpeakerParallels } from "../../src/analysis/cross-speaker-parallels.js";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";

const h = (c: string) => `sha256:${c.repeat(64)}`;
let n = 0;
function occ(o: {
  post: string;
  name?: string;
  author?: string;
  passage: string;
  publishedAt?: string;
  speaker?: ClaimOccurrence["speaker"];
}): ClaimOccurrence {
  n++;
  const speaker =
    o.speaker ??
    (o.name
      ? { kind: "quoted" as const, name: o.name, evidence: { start: 0, end: o.name.length } }
      : { kind: "author-voice" as const });
  return {
    schemaVersion: 1,
    occurrenceId: `sha256:${n.toString(16).padStart(64, "0")}`,
    grouping: { key: normalisedClaimKey(o.passage), method: "normalised-text", version: "1" },
    publicationId: "pub",
    postId: o.post,
    url: `https://pub.example.com/p/${o.post}`,
    claimId: h("c"),
    statement: o.passage,
    claimType: "factual",
    qualifiers: [],
    passage: o.passage,
    span: { start: 0, end: o.passage.length },
    sourceVersion: h("d"),
    artifact: {
      repository: "archive",
      commit: "a".repeat(40),
      path: `${o.post}.json`,
      hash: h("e"),
    },
    ...(o.publishedAt ? { sourcePublishedAt: o.publishedAt } : {}),
    assertionDates: [],
    themes: [],
    publisher: { publicationId: "pub", ...(o.author ? { author: o.author } : {}) },
    speaker,
    extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-06-01T00:00:00Z" },
  };
}

const CURRENT = "The masts were switched on to weaken immunity before the outbreak.";
const current = occ({
  post: "now",
  name: "Dr Synthetic",
  passage: CURRENT,
  publishedAt: "2026-06-01T00:00:00Z",
});
// A genuine parallel from another speaker, writing in their own voice.
const PARALLEL = "Engineers activated the towers to suppress immune response ahead of the virus.";
const genuine = occ({
  post: "other",
  author: "Jo Writer",
  speaker: { kind: "author-voice" },
  passage: PARALLEL,
  publishedAt: "2025-02-01T00:00:00Z",
});
// The same speaker again elsewhere: not cross-speaker.
const sameSpeaker = occ({
  post: "again",
  name: "dr synthetic",
  passage: "Masts weaken immunity, I said.",
  publishedAt: "2025-01-01T00:00:00Z",
});
// Topic only.
const TOPIC = "The towers on the ring road are an eyesore.";
const topic = occ({
  post: "topic",
  name: "Cllr Grey",
  passage: TOPIC,
  publishedAt: "2026-01-01T00:00:00Z",
});
// A repost of the current passage under another name, and a repost of the genuine parallel.
const quotedCurrent = occ({
  post: "reblog",
  name: "Sam Repost",
  passage: CURRENT,
  publishedAt: "2026-06-02T00:00:00Z",
});
const repostGenuine = occ({
  post: "other-repost",
  author: "Jo Writer",
  speaker: { kind: "author-voice" },
  passage: PARALLEL,
  publishedAt: "2025-03-01T00:00:00Z",
});
// A speaker who credits the current speaker.
const CITING = "As Dr Synthetic showed, the masts were used to weaken immunity.";
const citing = occ({
  post: "cite",
  name: "Lee Fan",
  passage: CITING,
  publishedAt: "2026-05-01T00:00:00Z",
});

const port = (docs: ClaimOccurrence[]): OccurrenceSearchPort => ({
  search: async () => docs.map((source, i) => ({ id: String(i), score: 1, source })),
});
const model = (answer: unknown): ExtractionModelProvider & { calls: number; user?: string } => ({
  modelVersion: "test/model",
  calls: 0,
  async complete(req) {
    this.calls++;
    this.user = req.user;
    return JSON.stringify(answer);
  },
});

describe("findCrossSpeakerParallels (#371)", () => {
  it("finds a genuine parallel, rejects topic-only, and does not double count reposts", async () => {
    const provider = model({
      parallels: [
        {
          candidate: "c1",
          quote: PARALLEL,
          relation: "agrees",
          difference: "Same mechanism; names engineers.",
          confidence: "high",
        },
        {
          candidate: "c2",
          quote: TOPIC,
          relation: "diverges",
          difference: "Only about towers.",
          confidence: "low",
        },
      ],
    });
    const r = await findCrossSpeakerParallels({
      search: port([genuine, repostGenuine, sameSpeaker, topic, quotedCurrent, current]),
      occurrence: current,
      provider,
    });
    expect(r.outcome).toBe("parallels");
    expect(r.parallels).toHaveLength(1);
    expect(r.parallels[0]).toMatchObject({
      postId: "other",
      speaker: { name: "Jo Writer", basis: "post-author" },
      quote: PARALLEL,
      publishedAt: "2025-02-01T00:00:00Z",
      relation: "agrees",
      attribution: "parallel",
      artifact: { path: "other.json" },
    });
    expect(r.diagnostics).toMatchObject({
      candidates: 2,
      excludedSameSpeaker: 1,
      excludedReposts: 2,
      rejectedByModel: 1,
    });
    // Only the two distinct candidates reach the model.
    expect(provider.user).not.toContain("Sam Repost");
  });

  it("marks borrowing only with a verbatim credit naming the speaker", async () => {
    const provider = model({
      parallels: [
        {
          candidate: "c1",
          quote: "the masts were used to weaken immunity",
          relation: "agrees",
          difference: "x",
          citationQuote: "As Dr Synthetic showed",
          confidence: "high",
        },
      ],
    });
    const r = await findCrossSpeakerParallels({
      search: port([citing]),
      occurrence: current,
      provider,
    });
    expect(r.parallels[0]).toMatchObject({
      attribution: "cites",
      citationQuote: "As Dr Synthetic showed",
    });

    const invented = model({
      parallels: [
        {
          candidate: "c1",
          quote: PARALLEL,
          relation: "agrees",
          difference: "x",
          citationQuote: "copied from Dr Synthetic",
          confidence: "high",
        },
      ],
    });
    const r2 = await findCrossSpeakerParallels({
      search: port([genuine]),
      occurrence: current,
      provider: invented,
    });
    expect(r2.parallels[0]).toMatchObject({ attribution: "parallel" });
    expect(r2.parallels[0]).not.toHaveProperty("citationQuote");
  });

  it("handles no match, no candidates and unverified speakers", async () => {
    const none = await findCrossSpeakerParallels({
      search: port([topic]),
      occurrence: current,
      provider: model({ parallels: [] }),
    });
    expect(none.outcome).toBe("no-match");
    const empty = model({ parallels: [] });
    const nothing = await findCrossSpeakerParallels({
      search: port([sameSpeaker, quotedCurrent]),
      occurrence: current,
      provider: empty,
    });
    expect(nothing.outcome).toBe("no-candidates");
    expect(empty.calls).toBe(0);
    const anon = occ({ post: "anon", passage: CURRENT, publishedAt: "2026-06-01T00:00:00Z" });
    expect(
      (
        await findCrossSpeakerParallels({
          search: port([genuine]),
          occurrence: anon,
          provider: empty,
        })
      ).outcome,
    ).toBe("speaker-unverified");
  });
});
