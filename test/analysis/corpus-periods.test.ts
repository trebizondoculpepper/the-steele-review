import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { collectionArtifactPath } from "../../src/collection/collection-store.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { claimIdentityKey, extractGroundedClaims } from "../../src/analysis/grounded-claims.js";
import {
  projectCorpusPeriods,
  type CorpusPeriodManifest,
} from "../../src/analysis/corpus-periods.js";

const statement = "Towers control the weather.";
let dir: string, archive: GitArtifactStore, content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-periods-"));
  for (const name of ["archive", "content"]) await mkdir(join(dir, name));
  archive = new GitArtifactStore({ repoPath: join(dir, "archive"), repository: "archive" });
  content = new GitArtifactStore({ repoPath: join(dir, "content"), repository: "content" });
  await archive.initialise();
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function post(
  postId: string,
  date?: string,
  options: {
    empty?: boolean;
    noExtraction?: boolean;
    text?: string;
    complete?: boolean;
    repeated?: boolean;
  } = {},
): Promise<CorpusPeriodManifest["posts"][number]> {
  const item = {
    publicationId: "pub",
    postId,
    title: postId,
    url: `https://pub.example/p/${postId}`,
    ...(date ? { publishedAt: date } : {}),
  };
  const text = options.text ?? `${postId}: ${statement}${options.repeated ? ` ${statement}` : ""}`;
  const capture = await archive.write(
    collectionArtifactPath(item),
    JSON.stringify({
      item,
      text,
      complete: options.complete ?? true,
      ingestionReason: "backfill",
      supplied: {},
      provenance: {
        sourceUrl: item.url,
        acquiredAt: "2026-06-01T00:00:00Z",
        method: "article-html",
      },
    }),
  );
  const row = { publicationId: "pub", postId, capture };
  if (options.noExtraction || options.complete === false) return row;
  const claim = (occurrence = 1) => ({
    statement,
    passage: statement,
    occurrence,
    claimType: "factual",
    kind: "assertion",
    speaker: { kind: "author-voice" },
    themeIds: ["weather"],
    qualifiers: [],
    entities: [],
    dates: [],
  });
  const result = await extractGroundedClaims({
    artifacts: content,
    provider: {
      modelVersion: "fixture",
      complete: async () =>
        JSON.stringify({
          claims: options.empty ? [] : options.repeated ? [claim(), claim(2)] : [claim()],
        }),
    },
    themes: [{ id: "weather", name: "Weather", definition: "Weather narratives" }],
    source: {
      text,
      sourceVersion: sourceVersionFor(text),
      artifact: {
        repository: capture.repository,
        commit: capture.commit,
        path: capture.path,
        hash: `sha256:${capture.sha256}`,
      },
      publicationId: "pub",
      postId,
      url: item.url,
      publishedAt: date,
    },
  });
  if (result.status !== "extracted") throw Error("fixture extraction failed");
  return { ...row, extraction: result.recordRef };
}

async function run(
  posts: CorpusPeriodManifest["posts"],
  extra: Partial<CorpusPeriodManifest> = {},
) {
  const manifest: CorpusPeriodManifest = {
    schemaVersion: 1,
    family: { name: "Synthetic weather claim", groupingKeys: [claimIdentityKey(statement)] },
    scope: { description: "Synthetic analysed corpus", publications: ["pub"], complete: true },
    window: { start: "2026-01", end: "2026-03" },
    exactCopies: "include",
    posts,
    ...extra,
  };
  const hash = sourceVersionFor(JSON.stringify(manifest)).slice(7);
  const ref = await content.write(`period-inputs/${hash}.json`, JSON.stringify(manifest));
  return projectCorpusPeriods({ manifest: ref, archive, content });
}

describe("observed corpus periods", { timeout: 30_000 }, () => {
  it("uses UTC publication months and bounds the requested window", async () => {
    const a = await post("offset", "2026-01-31T23:30:00-02:00");
    expect((await run([a])).result.periods.map((p) => p.analysedPosts)).toEqual([0, 1]);
    await expect(run([a], { window: { start: "2026-03", end: "2026-01" } })).rejects.toMatchObject({
      code: "invalid-manifest",
    });
    await expect(run([a], { window: { start: "2000-01", end: "2026-01" } })).rejects.toMatchObject({
      code: "invalid-manifest",
    });
  });

  it("preserves missing-source coverage and rejects forged occurrence evidence", async () => {
    const a = await post("known", "2026-01-01T00:00:00Z");
    const missing = { ...a, capture: { ...a.capture, path: "missing.json" } };
    expect((await run([missing])).result.diagnostics.unavailableSources).toBe(1);
    const record = JSON.parse(await content.read(a.extraction!));
    record.claims[0].occurrence.passage = "A fabricated quotation.";
    const forged = await content.write("fixtures/forged-extraction.json", JSON.stringify(record));
    const out = await run([{ ...a, extraction: forged }]);
    expect(out.result.periods[0]).toMatchObject({ analysedPosts: 0, invalidExtractions: 1 });
  });
  it("keeps rates reproducible when the analysed corpus grows, and includes zero-claim results", async () => {
    const posts = [
      await post("jan-match", "2026-01-02T00:00:00Z"),
      await post("jan-empty", "2026-01-03T00:00:00Z", { empty: true }),
      await post("feb-one", "2026-02-02T00:00:00Z"),
      await post("feb-two", "2026-02-03T00:00:00Z"),
      await post("feb-empty-one", "2026-02-04T00:00:00Z", { empty: true }),
      await post("feb-empty-two", "2026-02-05T00:00:00Z", { empty: true }),
    ];
    const a = await run(posts),
      b = await run(posts);
    expect(a.result.periods.map((p) => [p.analysedPosts, p.matchedPosts])).toEqual([
      [2, 1],
      [4, 2],
    ]);
    expect(b.ref).toEqual(a.ref);
    expect(JSON.parse(await content.read(a.ref))).toEqual(a.result);
  });

  it("exposes changed matched-post frequency without confusing occurrences and posts", async () => {
    const out = await run([
      await post("jan", "2026-01-02T00:00:00Z"),
      await post("jan-empty", "2026-01-03T00:00:00Z", { empty: true }),
      await post("feb", "2026-02-01T00:00:00Z", { repeated: true }),
      await post("feb-two", "2026-02-02T00:00:00Z"),
    ]);
    expect(out.result.periods.map((p) => [p.analysedPosts, p.matchedPosts, p.occurrences])).toEqual(
      [
        [2, 1, 1],
        [2, 2, 3],
      ],
    );
  });

  it("does not treat missing analyses, partial captures or unknown dates as negative findings", async () => {
    const out = await run(
      [
        await post("known", "2026-01-01T00:00:00Z"),
        await post("missing", "2026-01-02T00:00:00Z", { noExtraction: true }),
        await post("partial", "2026-01-03T00:00:00Z", { complete: false }),
        await post("undated"),
        await post("outside", "2025-01-01T00:00:00Z"),
      ],
      { scope: { description: "Partial sample", publications: ["pub"], complete: false } },
    );
    expect(out.result.periods[0]).toMatchObject({
      archivedPosts: 3,
      analysedPosts: 1,
      missingExtractions: 2,
    });
    expect(out.result.diagnostics).toMatchObject({
      unknownDates: 1,
      outsideWindow: 1,
      incompleteCaptures: 1,
    });
    expect(out.result.truncated).toBe(true);
  });

  it("deduplicates redelivery, exposes identical text copies, and makes copy exclusion explicit", async () => {
    const a = await post("first", "2026-01-01T00:00:00Z", { text: statement });
    const b = await post("copy", "2026-02-01T00:00:00Z", { text: statement });
    const included = await run([b, a, a]);
    expect(included.result.diagnostics.duplicateEntries).toBe(1);
    expect(included.result.periods[1]).toMatchObject({
      identicalSourceCopies: 1,
      analysedPosts: 1,
    });
    const excluded = await run([b, a], { exactCopies: "exclude-identical-source" });
    expect(excluded.result.periods[1]).toMatchObject({
      excludedCopies: 1,
      analysedPosts: 0,
      occurrences: 0,
    });
  });

  it("requires one explicitly selected revision and rejects a capture belonging to another post", async () => {
    const a = await post("one", "2026-01-01T00:00:00Z");
    const b = await post("two", "2026-01-02T00:00:00Z");
    await expect(run([a, { ...a, capture: b.capture }])).rejects.toMatchObject({
      code: "ambiguous-revision",
    });
    await expect(run([{ ...a, capture: b.capture }])).rejects.toMatchObject({
      code: "capture-mismatch",
    });
    const selected = await run([a]);
    expect(selected.result.periods[0].analysedPosts).toBe(1);
  });

  it("reports an extraction from the wrong post as invalid, never as zero matching claims", async () => {
    const a = await post("one", "2026-01-01T00:00:00Z");
    const b = await post("two", "2026-01-02T00:00:00Z");
    const out = await run([{ ...a, extraction: b.extraction }]);
    expect(out.result.periods[0]).toMatchObject({
      archivedPosts: 1,
      analysedPosts: 0,
      invalidExtractions: 1,
    });
  });
});
