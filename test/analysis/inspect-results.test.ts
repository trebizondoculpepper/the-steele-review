import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import { extractGroundedClaims } from "../../src/analysis/grounded-claims.js";
import { inspectPost, isPartial, renderInspection } from "../../src/analysis/inspect-results.js";
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

  it("applies the limit to theme lists, keeps v1 claims as legacy and shows transcript time", async () => {
    await content.write(
      "theme-proposals/pub/post/many.json",
      JSON.stringify({
        schemaVersion: 1,
        post: { sourceType: "substack", ...post },
        sourceVersion: sourceVersionFor(TEXT),
        artifact,
        proposals: [
          { id: `theme-${"1".repeat(24)}`, title: "A" },
          { id: `theme-${"2".repeat(24)}`, title: "B" },
        ],
        rejected: [],
        catalogueContext: null,
        extraction: {
          schemaVersion: 1,
          modelVersion: "m",
          promptVersion: "p",
          proposedAt: "2026-01-01T00:00:00Z",
        },
      }),
    );
    await content.write(
      "claim-extractions/pub/post/legacy.json",
      JSON.stringify({
        schemaVersion: 1,
        post,
        sourceVersion: sourceVersionFor(TEXT),
        themeIds: [],
        claims: [
          {
            claim: { statement: "Old unclassified claim" },
            occurrence: {
              passage: "q",
              span: { start: 0, end: 1 },
              transcriptTime: { startSeconds: 12, endSeconds: 15 },
            },
            kind: "assertion",
            themeIds: [],
            classification: "unclassified",
          },
        ],
        rejected: [],
        extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    const r = await inspectPost(content, post, { limit: 1 });
    const themes = r.themeResults.find((t) => t.ref.endsWith("many.json"))!;
    expect(themes.proposals).toHaveLength(1);
    expect(themes).toMatchObject({ counts: { proposals: 2, rejected: 0 }, truncated: true });
    const legacy = r.claimResults.find((c) => c.ref.endsWith("legacy.json"))!;
    expect(legacy.accepted).toEqual([]);
    expect(legacy.legacy?.[0].statement).toBe("Old unclassified claim");
    const text = renderInspection(r);
    expect(text).toContain("Legacy v1 claims");
    expect(text).toContain("audio 12s–15s");
    expect(text).toContain("showing 1 of 2 themes");
  });

  it("reads saved results beyond one listing page", async () => {
    for (let i = 0; i < 205; i++)
      await content.write(`claim-extractions/pub/post/x${String(i).padStart(3, "0")}.json`, "{}");
    const r = await inspectPost(content, post);
    expect(r.claimResults).toHaveLength(205);
    expect(r.resultsTruncated).toBe(false);
  }, 120_000);

  it("keeps inspecting when one listed artifact cannot be resolved", async () => {
    await analyse();
    const broken = {
      list: content.list.bind(content),
      read: content.read.bind(content),
      lookup: async (path: string) => {
        if (path.startsWith("theme-proposals/")) throw new Error("missing blob");
        return content.lookup(path);
      },
    };
    const r = await inspectPost(broken, post);
    expect(r.themeResults[0]).toMatchObject({
      status: "unreadable",
      ref: expect.stringMatching(/^unresolved:theme-proposals\//),
    });
    expect(r.claimResults[0].status).toBe("ok");
  });

  it("validates projected claim fields from malformed saved data", async () => {
    await content.write(
      "claim-extractions/pub/post/odd.json",
      JSON.stringify({
        schemaVersion: 2,
        post,
        sourceVersion: sourceVersionFor(TEXT),
        themeIds: [],
        claims: [
          {
            claim: { statement: 42, span: "nope" },
            occurrence: {
              sourcePublishedAt: 12345,
              speaker: { kind: 7 },
              transcriptTime: { startSeconds: "x" },
            },
            kind: "assertion",
            themeIds: [],
            classification: "themed",
          },
        ],
        candidates: [],
        rejected: [],
        extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    const r = await inspectPost(content, post);
    const claim = r.claimResults[0].accepted![0];
    expect(claim).toMatchObject({
      statement: "",
      quotation: "",
      speaker: { kind: "unknown" },
      location: { start: -1, end: -1 },
    });
    expect(claim.sourcePublishedAt).toBeUndefined();
    expect(claim.location.transcriptSeconds).toBeUndefined();
    expect(() => renderInspection(r)).not.toThrow();
  });

  it("rejects well-typed but semantically invalid projected values", async () => {
    await content.write(
      "claim-extractions/pub/post/semantic.json",
      JSON.stringify({
        schemaVersion: 2,
        post,
        sourceVersion: sourceVersionFor(TEXT),
        themeIds: [],
        claims: [
          {
            claim: { statement: "A claim" },
            occurrence: {
              passage: "A claim",
              sourcePublishedAt: "not-a-date",
              speaker: { kind: "robot", name: "   " },
              transcriptTime: { startSeconds: -5, endSeconds: 3 },
            },
            kind: "assertion",
            themeIds: [],
            classification: "themed",
          },
          {
            claim: { statement: "Another claim" },
            occurrence: {
              passage: "Another claim",
              transcriptTime: { startSeconds: 30, endSeconds: 10 },
            },
            kind: "assertion",
            themeIds: [],
            classification: "themed",
          },
        ],
        candidates: [],
        rejected: [],
        extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    const r = await inspectPost(content, post);
    const [first, second] = r.claimResults[0].accepted!;
    expect(first.sourcePublishedAt).toBeUndefined();
    expect(first.location.transcriptSeconds).toBeUndefined();
    expect(first.speaker).toEqual({ kind: "unknown" });
    expect(second.location.transcriptSeconds).toBeUndefined();
    expect(() => renderInspection(r)).not.toThrow();
  });

  it("resolves theme titles from the claim result's own linked theme result", async () => {
    await analyse();
    const id = (await inspectPost(content, post)).themeResults[0].proposals![0].id;
    // A second saved theme result that reuses the same ID with different wording.
    await content.write(
      "theme-proposals/pub/post/zz-other.json",
      JSON.stringify({
        schemaVersion: 1,
        post: { sourceType: "substack", ...post },
        sourceVersion: sourceVersionFor(TEXT),
        artifact,
        proposals: [{ id, title: "GEOENGINEERING!" }],
        rejected: [],
        catalogueContext: null,
        extraction: {
          schemaVersion: 1,
          modelVersion: "other",
          promptVersion: "p",
          proposedAt: "2026-01-01T00:00:00Z",
        },
      }),
    );
    const r = await inspectPost(content, post);
    const accepted = r.claimResults.find((c) => c.status === "ok")!.accepted![0];
    expect(accepted.themes[0].title).toBe("Geoengineering");
  });

  it("marks a report partial when any saved result is unreadable", async () => {
    await analyse();
    expect(isPartial(await inspectPost(content, post))).toBe(false);
    await content.write("claim-extractions/pub/post/broken.json", "{not json");
    expect(isPartial(await inspectPost(content, post))).toBe(true);
  });

  it("reports unreadable results instead of hiding them", async () => {
    await content.write("claim-extractions/pub/post/broken.json", "{not json");
    const r = await inspectPost(content, post);
    expect(r.claimResults).toEqual([
      { ref: expect.stringMatching(/broken\.json$/), status: "unreadable" },
    ]);
  });
});
