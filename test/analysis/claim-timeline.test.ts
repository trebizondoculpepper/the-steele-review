import { describe, expect, it } from "vite-plus/test";
import {
  CLAIM_OCCURRENCE_INDEX_MAPPING,
  normalisedClaimKey,
  type ClaimOccurrence,
} from "../../src/analysis/claim-occurrence.js";
import {
  COVERAGE_CAVEAT,
  queryClaimTimeline,
  renderTimelineReport,
  type OccurrenceSearchPort,
} from "../../src/analysis/claim-timeline.js";

const STATEMENT = "The towers are watching everyone.";
const key = normalisedClaimKey(STATEMENT);
const h = (c: string) => `sha256:${c.repeat(64)}`;
let n = 0;
function occ(o: {
  post: string;
  publishedAt?: string;
  speaker?: ClaimOccurrence["speaker"];
  id?: string;
  publication?: string;
}): ClaimOccurrence {
  n++;
  const passage = `Dr Synthetic said "${STATEMENT}"`;
  return {
    schemaVersion: 1,
    occurrenceId: o.id ?? `sha256:${n.toString(16).padStart(64, "0")}`,
    grouping: { key, method: "normalised-text", version: "1" },
    publicationId: o.publication ?? "pub",
    postId: o.post,
    url: `https://pub.substack.com/p/${o.post}`,
    claimId: h("c"),
    statement: STATEMENT,
    claimType: "factual",
    qualifiers: [],
    passage,
    span: { start: 0, end: passage.length },
    sourceVersion: h("d"),
    artifact: {
      repository: "archive",
      commit: "a".repeat(40),
      path: `${o.post}.json`,
      hash: h("e"),
    },
    ...(o.publishedAt ? { sourcePublishedAt: o.publishedAt } : {}),
    assertionDates: [],
    themes: ["surveillance"],
    publisher: { publicationId: o.publication ?? "pub" },
    speaker: o.speaker ?? { kind: "unknown" },
    extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-06-01T00:00:00Z" },
  };
}

const quoted = { kind: "quoted" as const, name: "Dr Synthetic", evidence: { start: 0, end: 12 } };
const fixtures = [
  occ({ post: "jan", publishedAt: "2026-01-05T00:00:00Z", speaker: quoted, id: h("1") }),
  occ({
    post: "jan",
    publishedAt: "2026-01-05T00:00:00Z",
    speaker: { kind: "author-voice", name: "Host" },
  }),
  occ({ post: "mar", publishedAt: "2026-03-09T00:00:00Z", speaker: quoted }),
  occ({ post: "undated" }),
];

function fake(docs: unknown[]) {
  const calls: Array<{ query: unknown; options: unknown }> = [];
  const port: OccurrenceSearchPort = {
    async search(_index, query, options) {
      calls.push({ query, options });
      return docs.slice(0, options.size).map((source, i) => ({ id: String(i), score: 1, source }));
    },
  };
  return { port, calls };
}

describe("queryClaimTimeline", () => {
  it("separates occurrence and distinct-post counts and ignores reprocessed duplicates", async () => {
    // The first occurrence appears twice, as repeated processing would return it.
    const { port, calls } = fake([...fixtures, fixtures[0]]);
    const t = await queryClaimTimeline(port, { statement: STATEMENT });
    expect(t.occurrenceCount).toBe(4);
    expect(t.distinctPostCount).toBe(3);
    expect(JSON.stringify(calls[0]!.query)).toContain(key);
  });

  it("reports earliest and latest observed, buckets and undated occurrences explicitly", async () => {
    const t = await queryClaimTimeline(fake(fixtures).port, { statement: STATEMENT });
    expect(t.earliestObserved?.postId).toBe("jan");
    expect(t.latestObserved?.postId).toBe("mar");
    expect(t.buckets).toEqual([
      { bucket: "2026-01", occurrences: 2, distinctPosts: 1 },
      { bucket: "2026-03", occurrences: 1, distinctPosts: 1 },
    ]);
    expect(t.undatedOccurrences).toBe(1);
    expect(t.occurrences.at(-1)).not.toHaveProperty("sourcePublishedAt");
    expect(t.caveat).toBe(COVERAGE_CAVEAT);
  });

  it("counts speakers as attributed, keeping unknown speakers unknown", async () => {
    const t = await queryClaimTimeline(fake(fixtures).port, { statement: STATEMENT });
    expect(t.speakers).toEqual([
      { kind: "quoted", name: "Dr Synthetic", occurrences: 2, distinctPosts: 2 },
      { kind: "author-voice", name: "Host", occurrences: 1, distinctPosts: 1 },
      { kind: "unknown", occurrences: 1, distinctPosts: 1 },
    ]);
  });

  it("passes filters and date boundaries to the index, and flags truncation", async () => {
    const { port, calls } = fake(fixtures);
    const t = await queryClaimTimeline(port, {
      theme: "surveillance",
      publicationId: "pub",
      speakerName: "Dr Synthetic",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-31T23:59:59Z",
      limit: 2,
    });
    const q = JSON.stringify(calls[0]!.query);
    for (const part of [
      '"themes":"surveillance"',
      '"publicationId":"pub"',
      '"speaker.name":"Dr Synthetic"',
      '"gte":"2026-01-01T00:00:00Z"',
      '"lte":"2026-01-31T23:59:59Z"',
    ]) {
      expect(q).toContain(part);
    }
    expect(t.truncated).toBe(true);
  });

  it("rejects a query without a claim or theme, and an inverted date range", async () => {
    const { port } = fake([]);
    await expect(queryClaimTimeline(port, { publicationId: "pub" })).rejects.toThrow();
    await expect(
      queryClaimTimeline(port, {
        theme: "x",
        from: "2026-02-01T00:00:00Z",
        to: "2026-01-01T00:00:00Z",
      }),
    ).rejects.toThrow();
  });

  it("skips documents that do not match the occurrence contract", async () => {
    const t = await queryClaimTimeline(fake([fixtures[0], { bogus: true }]).port, {
      statement: STATEMENT,
    });
    expect(t).toMatchObject({ occurrenceCount: 1, invalidDocuments: 1 });
  });

  it("renders a readable report with sources, unknowns and the coverage caveat", async () => {
    const report = renderTimelineReport(
      await queryClaimTimeline(fake(fixtures).port, { statement: STATEMENT }),
    );
    expect(report).toContain("Occurrences: 4 in 3 distinct post(s)");
    expect(report).toContain("Dr Synthetic (quoted)");
    expect(report).toContain("unknown speaker");
    expect(report).toContain("date unknown");
    expect(report).toContain("https://pub.substack.com/p/mar");
    expect(report).toContain(COVERAGE_CAVEAT);
  });
});

const esUrl = process.env.STEELE_TEST_ES_URL;
describe.skipIf(!esUrl)("queryClaimTimeline with Elasticsearch", () => {
  it("queries the strict occurrence mapping with sorting and filters", async () => {
    const { ElasticsearchController } = await import("../../src/controllers/elasticsearch.js");
    const { Client } = await import("@elastic/elasticsearch");
    const es = new ElasticsearchController(esUrl!);
    const admin = new Client({ node: esUrl! });
    const alias = `steele-claim-timeline-test-${Date.now().toString(36)}`;
    try {
      await es.provisionIndex(alias, CLAIM_OCCURRENCE_INDEX_MAPPING);
      for (const o of fixtures)
        await es.indexDocument(alias, o.occurrenceId, o, { refresh: "wait_for" });
      // Reprocessing rewrites the same ID in place.
      await es.indexDocument(alias, fixtures[0]!.occurrenceId, fixtures[0], {
        refresh: "wait_for",
      });
      const t = await queryClaimTimeline(es, { statement: STATEMENT }, alias);
      expect(t).toMatchObject({ occurrenceCount: 4, distinctPostCount: 3, undatedOccurrences: 1 });
      expect(t.occurrences.map((o) => o.postId)).toEqual(["jan", "jan", "mar", "undated"]);
      const quotedOnly = await queryClaimTimeline(
        es,
        { statement: STATEMENT, speakerName: "Dr Synthetic" },
        alias,
      );
      expect(quotedOnly.occurrenceCount).toBe(2);
      const january = await queryClaimTimeline(
        es,
        { statement: STATEMENT, from: "2026-01-01T00:00:00Z", to: "2026-01-31T23:59:59Z" },
        alias,
      );
      expect(january).toMatchObject({ occurrenceCount: 2, undatedOccurrences: 0 });
    } finally {
      await admin.indices.delete({ index: `${alias}-000001` }).catch(() => undefined);
      await admin.close();
      await es.close();
    }
  }, 60_000);
});
