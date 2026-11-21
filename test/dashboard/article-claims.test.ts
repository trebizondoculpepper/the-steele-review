import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { renderTrace } from "../../src/dashboard/article-views.js";
import { traceArticle } from "../../src/dashboard/articles.js";
import { savedClaims } from "../../src/dashboard/claims.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { TEXT, librarianFixtures } from "../research/librarian-fixtures.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-article-claims-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const post = { publicationId: "pub", postId: "p1" };
const version = sourceVersionFor(TEXT);
const occurrence = (passage: string, start: number) => ({
  passage,
  span: { start, end: start + passage.length },
  speaker: { kind: "author-voice" },
  sourcePublishedAt: "2026-01-02T00:00:00Z",
  occurrenceId: `sha256:${String(start).padStart(64, "0")}`,
});

/** A pinned theme result to reference; never attached to the post under test. */
async function themeResultForSeed() {
  const fx = librarianFixtures(content);
  return (await fx.analysis("seed-post", [{ id: "seed", statement: "seed" }])).themeResult;
}

/** A saved claim extraction for one post id, with each category populated. */
async function extraction(
  postId: string,
  over: { sourceVersion?: string; schemaVersion?: number; file?: string } = {},
) {
  const themeResult = await themeResultForSeed();
  const record = {
    schemaVersion: over.schemaVersion ?? 4,
    post: { publicationId: "pub", postId },
    sourceVersion: over.sourceVersion ?? version,
    themeIds: [],
    themeResult: `${themeResult.commit}:${themeResult.path}`,
    claims: [
      {
        claim: { statement: "A treaty bans weather weapons." },
        occurrence: occurrence("A treaty bans weather weapons.", 0),
        kind: "assertion",
        themeIds: [],
        classification: "themed",
        claimRecordId: "claim-treaty",
      },
      {
        claim: { statement: "A treaty bans weather weapons." },
        occurrence: occurrence("the treaty bans weather weapons", 120),
        kind: "assertion",
        themeIds: [],
        classification: "themed",
        claimRecordId: "claim-treaty",
      },
    ],
    candidates: [
      {
        claim: { statement: "<script>alert(1)</script> They knew." },
        occurrence: occurrence("They knew.", 300),
        kind: "assertion",
        themeIds: [],
        reasons: ["unclear-referent"],
      },
    ],
    rejected: [
      { index: 3, reason: "passage-not-found" },
      {
        index: 4,
        reason: "passage-not-found",
        candidate: {
          fields: { statement: "Masts cause illness.", passage: "masts cause illness" },
          truncated: false,
        },
      },
    ],
    extraction: { modelVersion: "fake/m", promptVersion: "p", extractedAt: "2026-01-03T00:00:00Z" },
  };
  await content.write(
    `claim-extractions/pub/${postId}/${over.file ?? "full"}.json`,
    JSON.stringify(record),
  );
  return themeResult;
}

const traceWith = async (themesVersion = version) =>
  traceArticle({
    post,
    articles: {
      recent: async () => [],
      find: async () => ({ ...post, sourceVersion: themesVersion }),
    },
    claims: savedClaims(content),
  });

describe("article claim links (#497)", { timeout: 60_000 }, () => {
  it("lists accepted occurrences, candidates and rejections separately", async () => {
    await extraction("p1");
    const trace = await traceWith();
    expect(trace.claims).toMatchObject({ state: "ok" });
    expect(trace.claims!.accepted).toHaveLength(2);
    expect(trace.claims!.accepted[0]).toMatchObject({
      result: "claim-extractions/pub/p1/full.json",
      category: "accepted",
      index: 0,
      statement: "A treaty bans weather weapons.",
      kind: "assertion",
      claimRecordId: "claim-treaty",
    });
    // Repeated occurrences keep distinct occurrence identities.
    expect(trace.claims!.accepted[1]!.occurrenceId).not.toBe(
      trace.claims!.accepted[0]!.occurrenceId,
    );
    expect(trace.claims!.candidates[0]).toMatchObject({
      category: "candidate",
      index: 0,
      reasons: ["unclear-referent"],
    });
    expect(trace.claims!.rejected.map((r) => r.rejectionReason)).toEqual([
      "passage-not-found",
      "passage-not-found",
    ]);
  });

  it("links each claim to its own saved occurrence detail", async () => {
    await extraction("p1");
    const html = renderTrace(await traceWith());
    expect(html).toContain("Claims");
    expect(html).toContain(
      "/claims/view?result=claim-extractions%2Fpub%2Fp1%2Ffull.json&amp;category=accepted&amp;index=0",
    );
    expect(html).toContain("&amp;category=accepted&amp;index=1");
    expect(html).toContain("&amp;category=candidate&amp;index=0");
    expect(html).toContain("&amp;category=rejected&amp;index=0");
    expect(html).toContain("not truth or research verdicts");
    // Hostile statement text is escaped, never executed.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("never substitutes a different saved revision of the same post", async () => {
    await extraction("p1");
    const trace = await traceWith(`sha256:${"a".repeat(64)}`);
    expect(trace.claims).toEqual({
      state: "not-analysed",
      accepted: [],
      legacy: [],
      candidates: [],
      rejected: [],
    });
  });

  it("reports an analysed revision with no claims as ok and empty", async () => {
    await extraction("p1");
    const record = JSON.parse(
      await content.read((await content.lookup("claim-extractions/pub/p1/full.json"))!),
    );
    record.claims = [];
    record.candidates = [];
    record.rejected = [];
    await content.write("claim-extractions/pub/p1only/empty.json", JSON.stringify(record));
    const trace = await traceArticle({
      post: { publicationId: "pub", postId: "p1only" },
      articles: {
        recent: async () => [],
        find: async () => ({ publicationId: "pub", postId: "p1only", sourceVersion: version }),
      },
      claims: savedClaims(content),
    });
    expect(trace.claims!.state).toBe("ok");
    expect(trace.claims!.accepted).toEqual([]);
  });

  it("separates legacy extractions instead of certifying them", async () => {
    await extraction("legacy-post", { schemaVersion: 1 });
    const trace = await traceArticle({
      post: { publicationId: "pub", postId: "legacy-post" },
      articles: {
        recent: async () => [],
        find: async () => ({ publicationId: "pub", postId: "legacy-post", sourceVersion: version }),
      },
      claims: savedClaims(content),
    });
    expect(trace.claims!.state).toBe("ok");
    expect(trace.claims!.accepted).toEqual([]);
    expect(trace.claims!.legacy).toHaveLength(2);
    expect(renderTrace(trace)).toContain("shown as recorded, not re-certified");
  });

  it("reports not-analysed, unavailable and partial states explicitly", async () => {
    const missing = await traceWith();
    expect(missing.claims!.state).toBe("not-analysed");
    expect(renderTrace(missing)).toContain("No claims are saved for this exact revision");

    await extraction("p1");
    await content.write("claim-extractions/pub/p1/broken.json", "{not json");
    const partial = await traceWith();
    expect(partial.claims!.state).toBe("partial");
    expect(renderTrace(partial)).toContain("claim scan was incomplete");
  });
});
