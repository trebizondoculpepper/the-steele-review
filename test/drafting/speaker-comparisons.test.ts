import { OperationStore } from "../../src/controllers/operation-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { normalisedClaimKey, type ClaimOccurrence } from "../../src/analysis/claim-occurrence.js";
import type { OccurrenceSearchPort } from "../../src/analysis/claim-timeline.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { draftFromPackage } from "../../src/drafting/package-draft.js";
import { saveSpeakerComparisons } from "../../src/drafting/speaker-comparisons.js";
import { saveWriterPackage } from "../../src/drafting/writer-package.js";
import { LexicalShortlister, assessPostCoverage } from "../../src/research/librarian.js";
import { SHARED, TEXT, librarianFixtures } from "../research/librarian-fixtures.js";

// #370: a post with a known prior claim from the same speaker, through the
// normal package and writer path; and a no-match run that keeps diagnostics
// but leaves history out of the article.
let operations: OperationStore;
let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-speaker-cmp-"));
  operations = new OperationStore({ path: join(dir, "state.sqlite") });
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  operations.close();
  await rm(dir, { recursive: true, force: true });
});

/** In-memory archive returning the captured post the fixtures point at. */
const archive = {
  read: async () =>
    JSON.stringify({
      item: { publicationId: "pub", postId: "p1", url: "https://pub.example.com/p/p1", title: "T" },
      ingestionReason: "backfill",
      text: TEXT,
      complete: true,
      supplied: {},
      provenance: {
        sourceUrl: "https://pub.example.com/p/p1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        method: "article-html",
      },
    }),
} as never;

const NAME = "Dr Synthetic";
const STATEMENT = "A treaty prohibits hostile environmental modification";
const PASSAGE = "A treaty bans weather weapons.";
const EARLIER = "the treaty already bans weather weapons, as I said then";
const h = (c: string) => `sha256:${c.repeat(64)}`;
const SOURCE = {
  repository: "archive",
  commit: "a".repeat(40),
  path: "substack/pub/p1/collected.json",
  hash: `sha256:${"b".repeat(64)}`,
};

function occurrence(o: Partial<ClaimOccurrence> & { postId: string }): ClaimOccurrence {
  const passage = o.passage ?? PASSAGE;
  return {
    schemaVersion: 1,
    occurrenceId: o.occurrenceId ?? h("1"),
    grouping: {
      key: normalisedClaimKey(o.statement ?? STATEMENT),
      method: "normalised-text",
      version: "1",
    },
    publicationId: "pub",
    url: `https://pub.example.com/p/${o.postId}`,
    claimId: h("c"),
    statement: STATEMENT,
    claimType: "factual",
    qualifiers: [],
    passage,
    span: { start: 0, end: passage.length },
    sourceVersion: sourceVersionFor(TEXT),
    artifact: SOURCE,
    sourcePublishedAt: "2026-06-01T00:00:00Z",
    assertionDates: [],
    themes: [],
    publisher: { publicationId: "pub" },
    speaker: { kind: "quoted", name: NAME, evidence: { start: 0, end: 1 } },
    extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-06-01T00:00:00Z" },
    ...o,
  };
}

const prior = occurrence({
  postId: "earlier",
  occurrenceId: h("2"),
  statement: "The treaty already bans weather weapons.",
  passage: `Intro. ${EARLIER}.`,
  span: { start: 40, end: 40 + `Intro. ${EARLIER}.`.length },
  sourceVersion: h("9"),
  artifact: { ...SOURCE, path: "substack/pub/earlier/collected.json" },
  sourcePublishedAt: "2023-05-01T00:00:00Z",
});

/** Coverage whose claim result carries a real, attributed occurrence. */
async function coverage() {
  const fx = librarianFixtures(content);
  const { themeResult, claimResult } = await fx.analysis("p1", [
    { id: "claim-treaty", statement: STATEMENT },
  ]);
  const raw = JSON.parse(await content.read(claimResult));
  raw.claims[0].occurrence = occurrence({ postId: "p1" });
  const attributed = await content.write(
    "claim-extractions/pub/p1/attributed.json",
    JSON.stringify(raw),
  );
  const out = await assessPostCoverage({
    artifacts: content,
    themeResult,
    claimResult: attributed,
    commission: fx.researcher(() => ({
      passages: [{ claimRecordId: "claim-treaty", url: SHARED }],
    })).commission,
    shortlister: new LexicalShortlister(),
  });
  return { coverage: out.ref, claimResult: attributed };
}

const search = (docs: ClaimOccurrence[]): OccurrenceSearchPort => ({
  async search(_i, query) {
    return JSON.stringify(query).includes('"exists"')
      ? []
      : docs.map((source, i) => ({ id: String(i), score: 1, source }));
  },
});

/** One fake model for matching, comparison and writing, answering by prompt. */
function models(writer: unknown) {
  return {
    modelVersion: "fake/m",
    async complete(req: { system: string }) {
      if (req.system.includes("earlier passages from the same speaker make the same"))
        return JSON.stringify({
          matches: [
            { candidate: "c1", quote: EARLIER, confidence: "high", reason: "Same treaty claim." },
          ],
        });
      if (req.system.includes("Explain how one speaker's claim has repeated"))
        return JSON.stringify({
          findings: [
            {
              kind: "repetition",
              earlierId: "e1",
              earlierQuote: EARLIER,
              aspects: {},
              explanation: "The same treaty claim, made in 2023.",
              uncertainty: "low",
            },
          ],
        });
      return JSON.stringify(writer);
    },
  };
}

const ESSAY = {
  title: "A treaty already bans weather weapons",
  subtitle: "What the post claims, and what the evidence shows",
  excerpt:
    "The post says a treaty bans weather weapons; it does, but the payment claim is unsupported.",
  summary: "The post says a treaty bans weather weapons.",
  themes: ["Weather warfare"],
  responses: [
    {
      claimRecordId: "claim-treaty",
      verdict: "supported",
      text: "The ENMOD Convention does.",
      evidence: [0],
    },
  ],
  limitations: [],
  widerContext: { status: "limited", limitation: "No independent background was used." },
};

describe("same-speaker comparisons in the unattended essay (#370)", { timeout: 60_000 }, () => {
  it("cites a known prior claim by date and link through the normal writer path", async () => {
    const { coverage: cov, claimResult } = await coverage();
    const provider = models({
      ...ESSAY,
      narrative: {
        status: "supported",
        text: "Dr Synthetic made this point before.",
        history: [0],
      },
    });
    const refs = await saveSpeakerComparisons({
      content,
      claimResult,
      deps: { search: search([prior]), provider },
    });
    expect(refs).toHaveLength(1);
    const record = JSON.parse(await content.read(refs[0]!));
    expect(record).toMatchObject({
      kind: "speaker-history",
      pattern: "single-comparison",
      search: { outcome: "matches" },
    });
    expect(record.findings[0].earlier[0]).toMatchObject({
      quote: EARLIER,
      start: 47,
      end: 47 + EARLIER.length,
    });

    const { package: pkg, ref } = await saveWriterPackage({
      content,
      coverage: cov,
      comparisons: refs,
      historyGap: "omit",
    });
    expect(pkg.context!.history).toMatchObject({
      status: "available",
      comparisons: [{ kind: "repetition", pattern: "single-comparison" }],
    });
    const out = await draftFromPackage({
      operations,
      content,
      archive,
      package: ref,
      provider,
      sourceUrl: "https://pub.example.com/p/p1",
    });
    if (out.status !== "drafted") throw new Error(out.status);
    const md = await content.read(out.draft);
    expect(md).toContain(
      `> "${EARLIER}" (2023-05-01T00:00:00Z, https://pub.example.com/p/earlier)`,
    );
    expect(md).toContain("analysis, not evidence");

    // Rerun reuses the saved record, even if the index has changed since.
    const again = await saveSpeakerComparisons({
      content,
      claimResult,
      deps: { search: search([]), provider },
    });
    expect(again[0]!.path).toBe(refs[0]!.path);

    // A re-extraction that keeps the occurrence ID but changes the claim
    // must not reuse the comparison of the old claim.
    const raw = JSON.parse(await content.read(claimResult));
    raw.claims[0].occurrence.statement = "A treaty permits weather weapons";
    const reextracted = await content.write(
      "claim-extractions/pub/p1/reextracted.json",
      JSON.stringify(raw),
    );
    const fresh = await saveSpeakerComparisons({
      content,
      claimResult: reextracted,
      deps: { search: search([]), provider },
    });
    expect(fresh[0]!.path).not.toBe(refs[0]!.path);
  });

  it("records a no-match search for diagnostics and leaves history out of the article", async () => {
    const { coverage: cov, claimResult } = await coverage();
    const provider = models({ ...ESSAY, narrative: { status: "limited", limitation: "omitted" } });
    const refs = await saveSpeakerComparisons({
      content,
      claimResult,
      deps: { search: search([]), provider },
    });
    const record = JSON.parse(await content.read(refs[0]!));
    expect(record).toMatchObject({
      status: "no-history",
      findings: [],
      search: { outcome: "no-candidates", diagnostics: { candidates: 0 } },
    });
    const { package: pkg, ref } = await saveWriterPackage({
      content,
      coverage: cov,
      comparisons: refs,
      historyGap: "omit",
    });
    expect(pkg.context!.history).toMatchObject({ status: "gap", omitWhenAbsent: true });
    const out = await draftFromPackage({
      operations,
      content,
      archive,
      package: ref,
      provider,
      sourceUrl: "https://pub.example.com/p/p1",
    });
    if (out.status !== "drafted") throw new Error(out.status);
    const md = await content.read(out.draft);
    expect(md).not.toContain("omitted");
    expect(md).not.toMatch(/earlier post|history/i);
  });

  it("records a failed search without failing the run", async () => {
    const { claimResult } = await coverage();
    const broken: OccurrenceSearchPort = { search: async () => Promise.reject(new Error("down")) };
    const refs = await saveSpeakerComparisons({
      content,
      claimResult,
      deps: { search: broken, provider: models(ESSAY) },
    });
    expect(JSON.parse(await content.read(refs[0]!))).toMatchObject({
      status: "failed",
      search: { outcome: "search-failed" },
    });
  });
});
