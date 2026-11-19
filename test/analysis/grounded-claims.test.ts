import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import {
  ClaimRecordSchema,
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
  it("extracts grounded, attributed, theme-linked claims and keeps unclassified ones explicit", async () => {
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
    const { claims, rejected } = out.record;
    expect(claims.map((c) => [c.kind, c.classification])).toEqual([
      ["assertion", "themed"],
      ["quotation", "themed"],
      ["question", "themed"],
      ["speculation", "unclassified"],
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

    // Questions get no normalised claim record; others do, distinct from occurrences.
    expect(out.claimRecords).toHaveLength(3);
    expect(indexed).toHaveLength(4);
    expect(
      indexed.map((d) => (d.doc as unknown as { assertionKind: string }).assertionKind),
    ).toEqual(["assertion", "quotation", "question", "speculation"]);
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
      promptVersion: "grounded-claims-v2",
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
