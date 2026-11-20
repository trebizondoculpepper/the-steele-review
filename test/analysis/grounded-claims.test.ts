import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import {
  ClaimExtractionRecordSchema,
  ClaimRecordSchema,
  candidateReasons,
  claimRecordId,
  extractGroundedClaims,
} from "../../src/analysis/grounded-claims.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";

const TEXT = [
  "Geoengineering has not been going on for decades, says nobody.",
  'Dr Smith said "over 90% of planes spray aluminium" in 2019.',
  "Are they spraying us right now?",
  "Perhaps the heat is man-made.",
  "The bins were late again.",
].join(" ");
const source = (postId = "p1") => ({
  text: TEXT,
  sourceVersion: sourceVersionFor(TEXT),
  artifact: {
    repository: "archive",
    commit: "a".repeat(40),
    path: `substack/pub/${postId}/collected.json`,
    hash: `sha256:${"b".repeat(64)}`,
  },
  publicationId: "pub",
  postId,
  url: `https://pub.example.com/p/${postId}`,
});
const themes = [
  { id: "geoengineering", name: "Geoengineering", definition: "Deliberate weather modification." },
  { id: "aerial-spraying", name: "Aerial spraying", definition: "Spraying from aircraft." },
];

const claim = (over: Record<string, unknown>) => ({
  claimType: "factual",
  kind: "assertion",
  qualifiers: [],
  entities: [],
  dates: [],
  speaker: { kind: "author-voice" },
  themeIds: [],
  ...over,
});

const RESPONSE = JSON.stringify({
  claims: [
    claim({
      statement: "Geoengineering has not been going on for decades",
      passage: "Geoengineering has not been going on for decades",
      qualifiers: ["not"],
      themeIds: ["geoengineering"],
    }),
    claim({
      statement: "Over 90% of planes spray aluminium",
      kind: "quotation",
      passage: 'over 90% of planes spray aluminium" in 2019',
      qualifiers: ["over 90%"],
      dates: [{ text: "2019" }],
      speaker: { kind: "quoted", name: "Dr Smith", attribution: "Dr Smith said" },
      themeIds: ["aerial-spraying", "geoengineering"],
    }),
    claim({
      statement: "They are spraying us right now",
      kind: "question",
      passage: "Are they spraying us right now?",
      themeIds: ["aerial-spraying"],
    }),
    claim({
      statement: "The heat may be man-made",
      kind: "speculation",
      claimType: "ambiguous",
      passage: "Perhaps the heat is man-made.",
      qualifiers: ["Perhaps"],
    }),
    claim({ statement: "Bins late", passage: "The bins were late again.", themeIds: ["invented"] }),
    claim({
      statement: "X",
      passage: "Perhaps the heat is man-made.",
      speaker: { kind: "quoted", name: "Nobody Real", attribution: "not here" },
    }),
  ],
});

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-claims-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function model(...responses: string[]): ExtractionModelProvider {
  return {
    modelVersion: "fake/model",
    async complete() {
      const next = responses.shift();
      if (next === undefined) throw new Error("no response");
      return next;
    },
  };
}

describe("claimRecordId", () => {
  it("keeps signs and operators distinct but ignores case and spacing", () => {
    expect(claimRecordId("Prices rose +2%")).not.toBe(claimRecordId("Prices rose -2%"));
    expect(claimRecordId("Dose > 10 mSv")).not.toBe(claimRecordId("Dose < 10 mSv"));
    expect(claimRecordId("Dose  > 10 MSV")).toBe(claimRecordId("dose > 10 mSv"));
  });
});

describe("extractGroundedClaims", () => {
  it("accepts themed, self-contained assertions and keeps the rest as candidates (#182)", async () => {
    const indexed: Array<{ id: string; doc: { themes: string[] } }> = [];
    const index = {
      indexDocument: async (_i: string, id: string, doc: unknown) =>
        indexed.push({ id, doc: doc as { themes: string[] } }),
    };
    const out = await extractGroundedClaims({
      provider: model(RESPONSE),
      artifacts: content,
      index,
      source: source(),
      themes,
    });
    if (out.status !== "extracted") throw new Error(out.status);
    const { claims, rejected, candidates } = out.record;
    expect(out.record.schemaVersion).toBe(3);
    expect(claims.map((c) => [c.kind, c.classification])).toEqual([
      ["assertion", "themed"],
      ["quotation", "themed"],
    ]);
    // Questions, unthemed speculation and unclear referents are candidates, not claims.
    expect(candidates?.map((c) => [c.kind, c.reasons])).toEqual([
      ["question", ["question", "unclear-referent"]],
      ["speculation", ["no-theme"]],
    ]);
    expect(rejected.map((r) => r.reason)).toEqual(["unknown-theme-id", "speaker-not-evidenced"]);

    // Negation and quantity qualifiers survive; quoted speaker is evidenced.
    const negated = claims[0].claim as { statement: string; qualifiers: string[] };
    expect(negated.statement).toContain("not");
    const quoted = claims[1].occurrence as {
      speaker: { name: string; evidence: { start: number } };
      themes: string[];
      span: { start: number };
      assertionDates: unknown[];
    };
    expect(quoted.speaker.name).toBe("Dr Smith");
    expect(TEXT.slice(quoted.speaker.evidence.start)).toMatch(/^Dr Smith said/);
    expect(quoted.themes).toEqual(["aerial-spraying", "geoengineering"]);
    expect(quoted.span.start).toBe(TEXT.indexOf("over 90%"));
    expect(quoted.assertionDates).toEqual([{ text: "2019" }]);

    // Only accepted claims get normalised records and index entries.
    expect(out.claimRecords).toHaveLength(2);
    expect(indexed).toHaveLength(2);
    expect(
      indexed.map((d) => (d.doc as unknown as { assertionKind: string }).assertionKind),
    ).toEqual(["assertion", "quotation"]);
    expect(
      await content.lookup(`claims/${claimRecordId("The heat may be man-made")}.json`),
    ).toBeUndefined();
    const ref = await content.lookup(
      `claims/${claimRecordId("Over 90% of planes spray aluminium")}.json`,
    );
    const rec = ClaimRecordSchema.parse(JSON.parse(await content.read(ref!)));
    expect(rec.occurrences).toHaveLength(1);
    expect(rec.themeIds).toEqual(["aerial-spraying", "geoengineering"]);
  });

  it("reruns without model calls or extra occurrences, and a second post adds one occurrence", async () => {
    await extractGroundedClaims({
      provider: model(RESPONSE),
      artifacts: content,
      source: source(),
      themes,
    });
    const again = await extractGroundedClaims({
      provider: model(),
      artifacts: content,
      source: source(),
      themes,
    });
    expect(again.status === "extracted" && again.reused).toBe(true);
    const path = `claims/${claimRecordId("Geoengineering has not been going on for decades")}.json`;
    const read = async () =>
      ClaimRecordSchema.parse(JSON.parse(await content.read((await content.lookup(path))!)));
    expect((await read()).occurrences).toHaveLength(1);

    await extractGroundedClaims({
      provider: model(RESPONSE),
      artifacts: content,
      source: source("p2"),
      themes,
    });
    expect((await read()).occurrences.map((o) => o.postId)).toEqual(["p1", "p2"]);
  });

  it("does not reuse a cached extraction made against a different theme result", async () => {
    const one = await extractGroundedClaims({
      provider: model(RESPONSE),
      artifacts: content,
      source: source(),
      themes,
      themeResult: "c1:theme-proposals/a.json",
    });
    const two = await extractGroundedClaims({
      provider: model(RESPONSE),
      artifacts: content,
      source: source(),
      themes,
      themeResult: "c2:theme-proposals/b.json",
    });
    expect(one.status === "extracted" && one.reused).toBe(false);
    expect(two.status === "extracted" && two.reused).toBe(false);
    if (two.status !== "extracted") throw new Error();
    expect(two.record.themeResult).toBe("c2:theme-proposals/b.json");
    // The claim record now points at the newer extraction for the same occurrence.
    const ref = await content.lookup(
      `claims/${claimRecordId("Geoengineering has not been going on for decades")}.json`,
    );
    const rec = ClaimRecordSchema.parse(JSON.parse(await content.read(ref!)));
    expect(rec.occurrences).toHaveLength(1);
    expect(rec.occurrences[0].extraction).toBe(`${two.recordRef.commit}:${two.recordRef.path}`);
    if (one.status !== "extracted") throw new Error();
    expect(rec.occurrences[0].extractions).toEqual([
      `${one.recordRef.commit}:${one.recordRef.path}`,
      `${two.recordRef.commit}:${two.recordRef.path}`,
    ]);
  });

  it("records model and prompt versions and fails cleanly on invalid output", async () => {
    const ok = await extractGroundedClaims({
      provider: model(RESPONSE),
      artifacts: content,
      source: source(),
      themes,
    });
    if (ok.status !== "extracted") throw new Error();
    expect(ok.record.extraction).toMatchObject({
      modelVersion: "fake/model",
      promptVersion: "grounded-claims-v6",
    });
    const bad = await extractGroundedClaims({
      provider: model("nope", "{}"),
      artifacts: content,
      source: source("p3"),
      themes,
    });
    expect(bad).toMatchObject({ status: "failed", reason: "malformed-output", attempts: 2 });
    // Bounded, private diagnostics of each malformed attempt.
    const malformed = (bad as { malformed?: Array<{ reason: string; stage: string }> }).malformed;
    expect(malformed?.map((m) => m.stage)).toEqual(["schema", "schema"]);
    expect(malformed?.[0].reason).toBe("not-json");
  });
});

describe("record versions (#182)", () => {
  it("keeps version-1 records readable without re-certifying them", () => {
    const v1 = {
      schemaVersion: 1,
      post: { publicationId: "pub", postId: "p" },
      sourceVersion: `sha256:${"c".repeat(64)}`,
      themeIds: [],
      claims: [
        {
          claim: {},
          occurrence: {},
          kind: "assertion",
          themeIds: [],
          classification: "unclassified",
          claimRecordId: "claim-x",
        },
      ],
      rejected: [],
      extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-01-01T00:00:00Z" },
    };
    const parsed = ClaimExtractionRecordSchema.parse(v1);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.candidates).toBeUndefined();
  });

  it("accepts a themed claim whose speaker and date are unknown", () => {
    expect(
      candidateReasons("assertion", ["geoengineering"], "Geoengineering has run for decades"),
    ).toEqual([]);
    expect(candidateReasons("speculation", ["geoengineering"], "The heat may be man-made")).toEqual(
      [],
    );
    expect(candidateReasons("assertion", ["geoengineering"], "They are poisoning us")).toEqual([
      "unclear-referent",
    ]);
    // Impersonal and demonstrative constructions are self-contained.
    expect(
      candidateReasons(
        "assertion",
        ["geoengineering"],
        "It is illegal to modify weather for hostile purposes",
      ),
    ).toEqual([]);
    expect(
      candidateReasons("assertion", ["geoengineering"], "This treaty bans weather warfare"),
    ).toEqual([]);
  });
  it("recovers a quotation differing only in case, saving the source text and the candidate (#202)", async () => {
    const response = JSON.stringify({
      claims: [
        claim({
          statement: "Geoengineering has not been going on for decades",
          passage: "geoengineering HAS NOT been going on for decades",
          qualifiers: ["not"],
          themeIds: ["geoengineering"],
        }),
        claim({
          statement: "Geoengineering has been going on for decades",
          passage: "Geoengineering has been going on for decades",
          themeIds: ["geoengineering"],
        }),
      ],
    });
    const out = await extractGroundedClaims({
      provider: model(response),
      artifacts: content,
      source: source("p9"),
      themes,
    });
    if (out.status !== "extracted") throw new Error(out.status);
    expect(out.record.extraction.matchingVersion).toBe("2");
    expect(out.record.claims).toHaveLength(1);
    const saved = out.record.claims[0];
    expect((saved.occurrence as { passage: string }).passage).toBe(
      "Geoengineering has not been going on for decades",
    );
    expect(saved.match).toEqual({
      method: "formatting",
      candidate: "geoengineering HAS NOT been going on for decades",
    });
    // Dropping the negation is a material change, never recovered.
    expect(out.record.rejected.map((r) => r.reason)).toContain("passage-not-found");
  });

  it("keeps a pure call to action as a not-self-contained candidate", () => {
    expect(candidateReasons("assertion", ["geoengineering"], "Stop spraying us now")).toEqual([
      "not-self-contained",
    ]);
    expect(candidateReasons("assertion", ["geoengineering"], "Wake up and share this")).toEqual([
      "not-self-contained",
    ]);
    // An instruction that carries a checkable proposition is still a claim.
    expect(
      candidateReasons("assertion", ["geoengineering"], "Stop spraying because the soil is toxic"),
    ).toEqual([]);
    // A short factual assertion is never read as a pure imperative.
    expect(candidateReasons("assertion", ["geoengineering"], "Vote rigging happened")).toEqual([]);
    expect(candidateReasons("assertion", ["geoengineering"], "Fight back was the headline")).toEqual(
      [],
    );
  });

  it("accepts a short exact quotation that is self-contained", () => {
    // Exact equality with the passage is never on its own a rejection reason.
    expect(
      candidateReasons("quotation", ["geoengineering"], "The council raised fees by 3%"),
    ).toEqual([]);
  });
});
