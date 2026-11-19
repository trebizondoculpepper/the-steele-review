import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import { extractGroundedClaims } from "../../src/analysis/grounded-claims.js";
import { inspectPost, renderInspection } from "../../src/analysis/inspect-results.js";
import { proposeThemes } from "../../src/analysis/theme-proposals.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";

const TEXT = "Geoengineering has run for decades. Are they spraying us? The bins were late.";
const post = { publicationId: "pub", postId: "post" };
const artifact = {
  repository: "archive",
  commit: "a".repeat(40),
  path: "substack/pub/post/collected.json",
  hash: `sha256:${"b".repeat(64)}`,
};

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-inspect-SENTINELPATH-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const model = (...r: string[]): ExtractionModelProvider => ({
  modelVersion: "fake/m",
  async complete() {
    const next = r.shift();
    if (next === undefined) throw new Error("none");
    return next;
  },
});

const claim = (over: Record<string, unknown>) => ({
  claimType: "factual",
  kind: "assertion",
  qualifiers: [],
  entities: [],
  dates: [],
  speaker: { kind: "author-voice" },
  ...over,
});

async function analyse(text = TEXT) {
  const source = { text, sourceVersion: sourceVersionFor(text), artifact };
  const themes = await proposeThemes({
    provider: model(
      JSON.stringify({
        themes: [
          { title: "Geoengineering", description: "Weather modification claims." },
          { nope: 1 },
        ],
      }),
    ),
    artifacts: content,
    post,
    source,
  });
  if (themes.status !== "proposed") throw new Error(themes.status);
  const geo = themes.result.proposals[0].id;
  await extractGroundedClaims({
    provider: model(
      JSON.stringify({
        claims: [
          claim({
            statement: "Geoengineering has run for decades",
            passage: "Geoengineering has run for decades.",
            themeIds: [geo],
          }),
          claim({
            statement: "They are spraying us",
            kind: "question",
            passage: "Are they spraying us?",
            themeIds: [geo],
          }),
          claim({ statement: "Invented", passage: "not in the text", themeIds: [geo] }),
        ],
      }),
    ),
    artifacts: content,
    themes: themes.result.proposals.map((p) => ({
      id: p.id,
      name: p.title,
      definition: p.description ?? p.title,
    })),
    themeResult: `${themes.ref.commit}:${themes.ref.path}`,
    source: {
      ...source,
      publicationId: "pub",
      postId: "post",
      url: "https://pub.example.com/p/post",
      publishedAt: "2026-02-09T06:42:18.599Z",
    },
  });
}

describe("inspectPost", () => {
  it("distinguishes nothing saved from an empty result", async () => {
    const none = await inspectPost(content, post);
    expect(none.notFound).toBe(true);
    expect(renderInspection(none)).toContain("No saved theme or claim results");
  });

  it("shows themes, accepted claims with linked theme titles, candidates and rejection details", async () => {
    await analyse();
    const r = await inspectPost(content, post);
    expect(r.notFound).toBe(false);
    const t = r.themeResults[0];
    expect(t.proposals?.map((p) => p.title)).toEqual(["Geoengineering"]);
    expect(t.rejected).toEqual([{ reason: "malformed-theme", stage: "schema" }]);
    const c = r.claimResults[0];
    expect(c.counts).toEqual({ accepted: 1, candidates: 1, rejected: 1 });
    expect(c.accepted?.[0]).toMatchObject({
      statement: "Geoengineering has run for decades",
      themes: [{ title: "Geoengineering" }],
      quotation: "Geoengineering has run for decades.",
      location: { start: 0, end: 35 },
      sourcePublishedAt: "2026-02-09T06:42:18.599Z",
      speaker: { kind: "author-voice" },
    });
    expect(c.candidates?.[0].reasons).toEqual(["question", "unclear-referent"]);
    expect(c.rejected?.[0]).toMatchObject({
      reason: "passage-not-found",
      stage: "grounding",
      statement: "Invented",
    });
    expect(c.sourceVersionMismatch).toBeUndefined();
    const text = renderInspection(r);
    expect(text).toContain("Candidates (need refinement)");
    expect(text).toContain("reasons: question, unclear-referent");
  });

  it("bounds output, uses logical references only and flags mismatched source versions", async () => {
    await analyse();
    const r = await inspectPost(content, post, { limit: 1 });
    const json = JSON.stringify(r);
    expect(json).not.toContain("SENTINELPATH");
    expect(r.claimResults[0].ref).toMatch(/^[0-9a-f]{12}:claim-extractions\//);
    expect(r.claimResults[0].truncated).toBe(false);

    // A claim result linked to a theme result for different source text.
    const themesRef = (await content.list("theme-proposals", 10))[0];
    const ref = (await content.lookup(themesRef))!;
    await content.write(
      "claim-extractions/pub/post/mismatch.json",
      JSON.stringify({
        schemaVersion: 2,
        post,
        sourceVersion: sourceVersionFor("different text"),
        themeIds: [],
        themeResult: `${ref.commit}:${ref.path}`,
        claims: [],
        candidates: [],
        rejected: [],
        extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    const again = await inspectPost(content, post);
    expect(
      again.claimResults.find((c) => c.ref.endsWith("mismatch.json"))?.sourceVersionMismatch,
    ).toBe(true);
  });

  it("reports unreadable results instead of hiding them", async () => {
    await content.write("claim-extractions/pub/post/broken.json", "{not json");
    const r = await inspectPost(content, post);
    expect(r.claimResults).toEqual([
      { ref: expect.stringMatching(/broken\.json$/), status: "unreadable" },
    ]);
  });
});
