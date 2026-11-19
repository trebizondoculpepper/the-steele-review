import { describe, expect, it } from "vite-plus/test";
import {
  CLAIM_OCCURRENCE_INDEX_MAPPING,
  InvalidClaimOccurrenceError,
  createClaimOccurrence,
  normalisedClaimKey,
  parseClaimOccurrence,
  type OccurrenceSource,
} from "../../src/analysis/claim-occurrence.js";
import { createClaim } from "../../src/analysis/claim.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";

const QUOTED = 'Dr Synthetic Example said "the towers are watching everyone".';
const VOICE = "The synthetic meters were installed last spring without consent.";
const DATED = "On 12 March 2026 the synthetic council voted to raise fees.";
const TEXT = `${QUOTED} ${VOICE} ${DATED}`;
const artifact = {
  repository: "synthetic-archive",
  commit: "0123456789abcdef0123456789abcdef01234567",
  path: "substack/example-pub/a-post/collected.json",
  hash: `sha256:${"cd".repeat(32)}`,
};
const source: OccurrenceSource = {
  text: TEXT,
  sourceVersion: sourceVersionFor(TEXT),
  artifact,
  publicationId: "example-pub",
  postId: "a-post",
  url: "https://example-pub.substack.com/p/a-post",
  publishedAt: "2026-04-01T09:00:00Z",
  author: "Example Publisher",
};
const extraction = (model = "synthetic-model-v1") => ({
  modelVersion: model,
  promptVersion: "claim-extraction-v1",
  extractedAt: "2026-04-02T00:00:00Z",
});
const claimFor = (passage: string, extra: Record<string, unknown> = {}, model?: string) => {
  const start = TEXT.indexOf(passage);
  return createClaim(
    {
      statement: passage,
      claimType: "factual",
      sourceVersion: source.sourceVersion,
      span: { start, end: start + passage.length },
      passage,
      extraction: extraction(model),
      ...extra,
    },
    source,
  );
};

describe("createClaimOccurrence", () => {
  it("records a quoted speaker only with an attribution span that names them", () => {
    const claim = claimFor(QUOTED);
    const occurrence = createClaimOccurrence({
      claim,
      source,
      speaker: {
        kind: "quoted",
        name: "Dr Synthetic Example",
        evidence: { start: 0, end: QUOTED.length },
      },
      themes: ["Mass Surveillance"],
    });
    expect(occurrence).toMatchObject({
      speaker: { kind: "quoted", name: "Dr Synthetic Example" },
      publisher: { publicationId: "example-pub", author: "Example Publisher" },
      themes: ["mass surveillance"],
      sourcePublishedAt: "2026-04-01T09:00:00Z",
    });
    expect(() =>
      createClaimOccurrence({
        claim,
        source,
        speaker: {
          kind: "quoted",
          name: "Someone Else",
          evidence: { start: 0, end: QUOTED.length },
        },
      }),
    ).toThrow("does not occur");
  });

  it("never names a speaker from publication ownership alone", () => {
    const claim = claimFor(VOICE);
    expect(() =>
      createClaimOccurrence({
        claim,
        source,
        speaker: { kind: "author-voice", name: "Example Publisher" },
      }),
    ).toThrow("quoted or uncertain");
    const ok = createClaimOccurrence({ claim, source, speaker: { kind: "author-voice" } });
    expect(ok.speaker).toEqual({ kind: "author-voice" });
    expect(ok.publisher.author).toBe("Example Publisher");
  });

  it("allows unknown and uncertain attribution", () => {
    const claim = claimFor(VOICE);
    expect(
      createClaimOccurrence({ claim, source, speaker: { kind: "unknown" } }).speaker.kind,
    ).toBe("unknown");
    expect(
      createClaimOccurrence({ claim, source, speaker: { kind: "uncertain" } }).speaker.kind,
    ).toBe("uncertain");
  });

  it("keeps observed publication time separate from evidenced assertion dates and invents none", () => {
    const dated = createClaimOccurrence({
      claim: claimFor(DATED, { dates: [{ text: "12 March 2026", value: "2026-03-12" }] }),
      source,
      speaker: { kind: "author-voice" },
    });
    expect(dated.assertionDates).toEqual([{ text: "12 March 2026", value: "2026-03-12" }]);
    expect(dated.sourcePublishedAt).toBe("2026-04-01T09:00:00Z");

    const vague = createClaimOccurrence({
      claim: claimFor(VOICE, { dates: [{ text: "last spring" }] }),
      source: { ...source, publishedAt: undefined },
      speaker: { kind: "author-voice" },
    });
    expect(vague.assertionDates).toEqual([{ text: "last spring" }]);
    expect(vague).not.toHaveProperty("sourcePublishedAt");
  });

  it("gives repeat extraction of the same passage the same occurrence ID, distinct from the grouping key", () => {
    const first = createClaimOccurrence({
      claim: claimFor(VOICE),
      source,
      speaker: { kind: "author-voice" },
    });
    const again = createClaimOccurrence({
      claim: claimFor(VOICE, {}, "another-model-v2"),
      source,
      speaker: { kind: "author-voice" },
    });
    expect(again.occurrenceId).toBe(first.occurrenceId);
    expect(again.claimId).not.toBe(first.claimId);
    expect(first.grouping).toEqual({
      key: normalisedClaimKey(VOICE),
      method: "normalised-text",
      version: "1",
    });
    expect(first.grouping.key).not.toBe(first.occurrenceId);
    expect(
      normalisedClaimKey("The  SYNTHETIC meters were installed last spring, without consent!"),
    ).toBe(normalisedClaimKey(VOICE));
  });

  it("labels model-assisted grouping as revisable", () => {
    const grouped = createClaimOccurrence({
      claim: claimFor(VOICE),
      source,
      speaker: { kind: "author-voice" },
      grouping: {
        key: `sha256:${"9".repeat(64)}`,
        method: "model-assisted",
        version: "grouping-v1",
      },
    });
    expect(grouped.grouping.method).toBe("model-assisted");
  });

  it("records transcript times only when supplied timings cover the passage", () => {
    const start = TEXT.indexOf(VOICE);
    const timed = createClaimOccurrence({
      claim: claimFor(VOICE),
      source: {
        ...source,
        transcriptTimings: [{ start, end: start + 20, startSeconds: 61.5, endSeconds: 64 }],
      },
      speaker: { kind: "author-voice" },
    });
    expect(timed.transcriptTime).toEqual({ startSeconds: 61.5, endSeconds: 64 });
    const untimed = createClaimOccurrence({
      claim: claimFor(VOICE),
      source,
      speaker: { kind: "author-voice" },
    });
    expect(untimed).not.toHaveProperty("transcriptTime");
  });
});

describe("parseClaimOccurrence", () => {
  const valid = () =>
    createClaimOccurrence({ claim: claimFor(VOICE), source, speaker: { kind: "author-voice" } });

  it("round-trips a valid occurrence", () => {
    expect(parseClaimOccurrence(JSON.parse(JSON.stringify(valid())), source)).toEqual(valid());
  });

  it.each([
    [
      "tampered passage",
      (o: Record<string, unknown>) => ({ ...o, passage: "Something else entirely." }),
    ],
    [
      "forged occurrence ID",
      (o: Record<string, unknown>) => ({ ...o, occurrenceId: `sha256:${"0".repeat(64)}` }),
    ],
    ["other post", (o: Record<string, unknown>) => ({ ...o, postId: "other-post" })],
    [
      "invented assertion date",
      (o: Record<string, unknown>) => ({
        ...o,
        assertionDates: [{ text: "1 May 2020", value: "2020-05-01" }],
      }),
    ],
    ["verdict field", (o: Record<string, unknown>) => ({ ...o, verdict: "false" })],
    [
      "precise value for vague wording",
      (o: Record<string, unknown>) => ({
        ...o,
        assertionDates: [{ text: "last spring", value: "2020-05-01" }],
      }),
    ],
    [
      "substituted artifact",
      (o: Record<string, unknown>) => ({
        ...o,
        artifact: { ...(o.artifact as object), commit: "f".repeat(40) },
      }),
    ],
  ])("rejects a %s", (_name, mutate) => {
    expect(() =>
      parseClaimOccurrence(mutate(valid() as unknown as Record<string, unknown>), source),
    ).toThrow(InvalidClaimOccurrenceError);
  });
});

describe("CLAIM_OCCURRENCE_INDEX_MAPPING", () => {
  it("is strict and maps identity and attribution as keywords", () => {
    expect(CLAIM_OCCURRENCE_INDEX_MAPPING.dynamic).toBe("strict");
    expect(CLAIM_OCCURRENCE_INDEX_MAPPING.properties.occurrenceId.type).toBe("keyword");
    expect(CLAIM_OCCURRENCE_INDEX_MAPPING.properties.grouping.properties.key.type).toBe("keyword");
    expect(CLAIM_OCCURRENCE_INDEX_MAPPING.properties.speaker.properties.kind.type).toBe("keyword");
    expect(CLAIM_OCCURRENCE_INDEX_MAPPING.properties.sourcePublishedAt.type).toBe("date");
  });
});

// Controlled check that the explicit mapping accepts real occurrences.
const esUrl = process.env.STEELE_TEST_ES_URL;
describe.skipIf(!esUrl)("claim occurrence mapping in Elasticsearch", () => {
  it("indexes occurrences under the strict mapping with one document per occurrence ID", async () => {
    const { ElasticsearchController } = await import("../../src/controllers/elasticsearch.js");
    const { Client } = await import("@elastic/elasticsearch");
    const es = new ElasticsearchController(esUrl!);
    const admin = new Client({ node: esUrl! });
    const alias = `steele-claim-occurrences-test-${Date.now().toString(36)}`;
    try {
      await es.provisionIndex(alias, CLAIM_OCCURRENCE_INDEX_MAPPING);
      const quoted = createClaimOccurrence({
        claim: claimFor(QUOTED, { qualifiers: [] }),
        source,
        speaker: {
          kind: "quoted",
          name: "Dr Synthetic Example",
          evidence: { start: 0, end: QUOTED.length },
        },
        themes: ["surveillance"],
      });
      const dated = createClaimOccurrence({
        claim: claimFor(DATED, { dates: [{ text: "12 March 2026", value: "2026-03-12" }] }),
        source,
        speaker: { kind: "author-voice" },
      });
      for (const o of [quoted, dated, quoted]) {
        await es.indexDocument(alias, o.occurrenceId, o, { refresh: "wait_for" });
      }
      expect((await admin.count({ index: alias })).count).toBe(2);
    } finally {
      await admin.indices.delete({ index: `${alias}-000001` }).catch(() => undefined);
      await admin.close();
      await es.close();
    }
  }, 60_000);
});
