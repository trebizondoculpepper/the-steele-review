import { describe, expect, it } from "vite-plus/test";
import { normalisedClaimKey, type ClaimOccurrence } from "../../src/analysis/claim-occurrence.js";
import type { OccurrenceSearchPort } from "../../src/analysis/claim-timeline.js";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import {
  findSameSpeakerHistory,
  speakerFilter,
  verifiedSpeaker,
} from "../../src/analysis/same-speaker-history.js";

const h = (c: string) => `sha256:${c.repeat(64)}`;
const NAME = "Dr Synthetic";
const CURRENT = "5G towers are being used to weaken people's immune systems.";
const RETELLING = "the masts were switched on to lower everyone's immunity before the virus";
const TOPIC_ONLY = "the new masts went up on the high street last spring";
let n = 0;

function occ(o: {
  post: string;
  statement: string;
  passage?: string;
  publishedAt?: string;
  speaker?: ClaimOccurrence["speaker"];
  author?: string;
}): ClaimOccurrence {
  n++;
  const passage = o.passage ?? `${NAME} said: ${o.statement}`;
  return {
    schemaVersion: 1,
    occurrenceId: `sha256:${n.toString(16).padStart(64, "0")}`,
    grouping: { key: normalisedClaimKey(o.statement), method: "normalised-text", version: "1" },
    publicationId: "pub",
    postId: o.post,
    url: `https://pub.substack.com/p/${o.post}`,
    claimId: h("c"),
    statement: o.statement,
    claimType: "factual",
    qualifiers: [],
    passage,
    span: { start: 0, end: passage.length },
    sourceVersion: `sha256:${o.post
      .padEnd(64, "0")
      .slice(0, 64)
      .replace(/[^0-9a-f]/g, "0")}`,
    artifact: {
      repository: "archive",
      commit: "a".repeat(40),
      path: `${o.post}.json`,
      hash: h("e"),
    },
    ...(o.publishedAt ? { sourcePublishedAt: o.publishedAt } : {}),
    assertionDates: [],
    themes: ["5g"],
    publisher: { publicationId: "pub", ...(o.author ? { author: o.author } : {}) },
    speaker: o.speaker ?? { kind: "quoted", name: NAME, evidence: { start: 0, end: NAME.length } },
    extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-06-01T00:00:00Z" },
  };
}

const current = occ({ post: "now", statement: CURRENT, publishedAt: "2026-06-01T00:00:00Z" });
const exact = occ({ post: "jan", statement: CURRENT, publishedAt: "2026-01-10T00:00:00Z" });
const retold = occ({
  post: "2025",
  statement: "Masts were activated to reduce immunity before the pandemic.",
  passage: `${NAME} wrote that ${RETELLING}.`,
  publishedAt: "2025-03-02T00:00:00Z",
});
const repost = {
  ...retold,
  occurrenceId: h("9"),
  postId: "2025-repost",
  sourcePublishedAt: "2025-04-02T00:00:00Z",
};
const topic = occ({
  post: "feb",
  statement: "New masts were installed on the high street.",
  passage: `${NAME} noted ${TOPIC_ONLY}.`,
  publishedAt: "2026-02-01T00:00:00Z",
});
const undated = occ({ post: "undated", statement: CURRENT });
const later = occ({ post: "july", statement: CURRENT, publishedAt: "2026-07-01T00:00:00Z" });

function port(docs: ClaimOccurrence[]) {
  const queries: unknown[] = [];
  const search: OccurrenceSearchPort = {
    async search(_i, query) {
      queries.push(query);
      // The undated-count query asks for documents without a publication date.
      const undatedOnly = JSON.stringify(query).includes('"exists"');
      return docs
        .filter((d) => (undatedOnly ? !d.sourcePublishedAt : true))
        .map((source, i) => ({ id: String(i), score: 1, source }));
    },
  };
  return { search, queries };
}

function model(answer: unknown): ExtractionModelProvider & { calls: number } {
  return {
    modelVersion: "test/model",
    calls: 0,
    async complete() {
      this.calls++;
      return JSON.stringify(answer);
    },
  };
}

describe("findSameSpeakerHistory (#368)", () => {
  it("returns exact and retold earlier claims with quotes, dates, links and pinned refs", async () => {
    const provider = model({
      matches: [
        { candidate: "c1", quote: RETELLING, confidence: "high", reason: "Same mechanism." },
        { candidate: "c2", quote: TOPIC_ONLY, confidence: "low", reason: "Topic only." },
      ],
    });
    const { search, queries } = port([exact, retold, repost, topic, undated, later, current]);
    const r = await findSameSpeakerHistory({ search, occurrence: current, provider });
    expect(r.outcome).toBe("matches");
    expect(r.speaker).toEqual({ name: NAME, basis: "named-speaker" });
    expect(r.matches.map((m) => [m.postId, m.matchedBy])).toEqual([
      ["2025", "model"],
      ["jan", "grouping"],
    ]);
    expect(r.matches[0]).toMatchObject({
      quote: RETELLING,
      publishedAt: "2025-03-02T00:00:00Z",
      url: "https://pub.substack.com/p/2025",
      speaker: { name: NAME },
      artifact: { path: "2025.json" },
    });
    expect(r.diagnostics).toMatchObject({
      excludedUndated: 1,
      excludedReposts: 1,
      rejectedByModel: 1,
      modelVersion: "test/model",
    });
    // The speaker, not the publication, scopes the search.
    expect(JSON.stringify(queries[0])).toContain(NAME);
    expect(JSON.stringify(queries[0])).not.toContain('"publicationId"');
  });

  it("reports no-match when only same-topic passages exist", async () => {
    const provider = model({ matches: [] });
    const r = await findSameSpeakerHistory({
      search: port([topic]).search,
      occurrence: current,
      provider,
    });
    expect(r).toMatchObject({
      outcome: "no-match",
      matches: [],
      diagnostics: { candidates: 1, rejectedByModel: 1 },
    });
  });

  it("reports no-candidates without calling the model", async () => {
    const provider = model({ matches: [] });
    const r = await findSameSpeakerHistory({
      search: port([later, undated]).search,
      occurrence: current,
      provider,
    });
    expect(r.outcome).toBe("no-candidates");
    expect(provider.calls).toBe(0);
  });

  it("drops quotes that are not verbatim in the candidate passage", async () => {
    const provider = model({
      matches: [
        { candidate: "c1", quote: "towers cause illness", confidence: "high", reason: "x" },
      ],
    });
    const r = await findSameSpeakerHistory({
      search: port([retold]).search,
      occurrence: current,
      provider,
    });
    expect(r.outcome).toBe("no-match");
  });

  it("never uses publication identity as speaker identity", async () => {
    const anonymous = occ({
      post: "x",
      statement: CURRENT,
      publishedAt: "2026-06-01T00:00:00Z",
      speaker: { kind: "author-voice" },
    });
    const provider = model({ matches: [] });
    const r = await findSameSpeakerHistory({
      search: port([exact]).search,
      occurrence: anonymous,
      provider,
    });
    expect(r.outcome).toBe("speaker-unverified");
    expect(
      verifiedSpeaker({ ...anonymous, publisher: { publicationId: "pub", author: "Jo Writer" } }),
    ).toEqual({
      name: "Jo Writer",
      basis: "post-author",
    });
    // A configured source author projected into the index (#461) is used, and
    // preferred over an account byline such as the publication's name.
    expect(
      verifiedSpeaker({
        ...anonymous,
        publisher: {
          publicationId: "pub",
          author: "Synthetic Account",
          attributedAuthor: "Configured Author",
          attributionBasis: "source-configured",
        },
      }),
    ).toEqual({ name: "Configured Author", basis: "post-author" });
    expect(
      JSON.stringify(speakerFilter({ name: "Configured Author", basis: "post-author" })),
    ).toContain("publisher.attributedAuthor");
    expect(
      verifiedSpeaker(
        occ({ post: "y", statement: CURRENT, speaker: { kind: "quoted", name: NAME } }),
      ),
    ).toBeUndefined();
  });

  it("rejects whitespace-only quotes", async () => {
    const provider = model({
      matches: [{ candidate: "c1", quote: "   ", confidence: "high", reason: "x" }],
    });
    const r = await findSameSpeakerHistory({
      search: port([retold]).search,
      occurrence: current,
      provider,
    });
    expect(r.outcome).toBe("no-match");
  });

  it("sends a shared grouping key with a different statement to the model", async () => {
    const plus = occ({
      post: "p",
      statement: "Output changed by +2%.",
      publishedAt: "2026-06-01T00:00:00Z",
    });
    const minus = occ({
      post: "m",
      statement: "Output changed by -2%.",
      publishedAt: "2026-01-01T00:00:00Z",
    });
    expect(minus.grouping.key).toBe(plus.grouping.key);
    const provider = model({ matches: [] });
    const r = await findSameSpeakerHistory({
      search: port([minus]).search,
      occurrence: plus,
      provider,
    });
    expect(r.outcome).toBe("no-match");
    expect(provider.calls).toBe(1);
  });

  it("bounds the search by date so later posts cannot crowd out history", async () => {
    const { search, queries } = port([exact]);
    await findSameSpeakerHistory({ search, occurrence: current, provider: model({ matches: [] }) });
    expect(JSON.stringify(queries[0])).toContain('"lt":"2026-06-01T00:00:00Z"');
  });
});
