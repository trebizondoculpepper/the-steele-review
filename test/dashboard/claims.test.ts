import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { claimViews } from "../../src/dashboard/claim-views.js";
import { savedClaims } from "../../src/dashboard/claims.js";
import { TEXT, librarianFixtures } from "../research/librarian-fixtures.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";

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

/** A saved claim extraction with occurrences, a candidate and a rejection. */
async function extraction(postId: string) {
  const fx = librarianFixtures(content);
  const { themeResult } = await fx.analysis(postId, [{ id: "seed", statement: "seed" }]);
  const theme = JSON.parse(await content.read(themeResult));
  const themeId = theme.proposals[0].id as string;
  const occurrence = (passage: string, start: number) => ({
    passage,
    span: { start, end: start + passage.length },
    speaker: { kind: "author-voice" },
    sourcePublishedAt: "2026-01-02T00:00:00Z",
    occurrenceId: `sha256:${String(start).padStart(64, "0")}`,
  });
  const record = {
    schemaVersion: 3,
    post: { publicationId: "pub", postId },
    sourceVersion: sourceVersionFor(TEXT),
    themeIds: [themeId],
    themeResult: `${themeResult.commit}:${themeResult.path}`,
    claims: [
      // The same normalised claim said twice: two occurrences, one record id.
      {
        claim: { statement: "A treaty bans weather weapons." },
        occurrence: occurrence("A treaty bans weather weapons.", 0),
        kind: "assertion",
        themeIds: [themeId],
        classification: "themed",
        claimRecordId: "claim-treaty",
      },
      {
        claim: { statement: "A treaty bans weather weapons." },
        occurrence: occurrence("the treaty bans weather weapons", 120),
        kind: "assertion",
        themeIds: [themeId],
        classification: "themed",
        claimRecordId: "claim-treaty",
        match: { method: "formatting", candidate: "the treaty bans weather weapons" },
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
  await content.write(`claim-extractions/pub/${postId}/full.json`, JSON.stringify(record));
  return { themeId, themeResult };
}

describe("claims browser (#494)", { timeout: 60_000 }, () => {
  it("keeps repeated occurrences, quote offsets and categories distinct", async () => {
    const { themeId, themeResult } = await extraction("p1");
    const claims = savedClaims(content);
    const all = (await claims.list({ post: "p1" })).rows.filter((r) =>
      r.result.endsWith("full.json"),
    );
    const accepted = all.filter((r) => r.category === "accepted");
    expect(accepted).toHaveLength(2);
    expect(accepted.map((r) => r.claimRecordId)).toEqual(["claim-treaty", "claim-treaty"]);
    expect(accepted.map((r) => r.span)).toEqual([
      { start: 0, end: 30 },
      { start: 120, end: 151 },
    ]);
    expect(accepted[1]!.quoteRecovered).toBe(true);
    expect(all.find((r) => r.category === "candidate")).toMatchObject({
      reasons: ["unclear-referent"],
    });
    expect(all.find((r) => r.category === "rejected")).toMatchObject({
      rejectionReason: "passage-not-found",
    });
    // Theme links are pinned to the exact theme result the extraction used.
    expect(accepted[0]!.themes[0]).toMatchObject({ id: themeId });
    expect(accepted[0]!.themeResultPath).toBe(themeResult.path);

    const byCategory = await claims.list({ post: "p1", category: "candidate" });
    expect(byCategory.rows.every((r) => r.category === "candidate")).toBe(true);
    const byTheme = await claims.list({ theme: themeId });
    expect(byTheme.rows.length).toBeGreaterThan(0);
    expect(byTheme.rows.every((r) => r.themes.some((t) => t.id === themeId))).toBe(true);
  });

  it("reads rejected text from the snapshot fields", async () => {
    await extraction("p4");
    const rows = (
      await savedClaims(content).list({ post: "p4", category: "rejected" })
    ).rows.filter((r) => r.result.endsWith("full.json"));
    expect(rows.find((r) => r.index === 1)).toMatchObject({
      statement: "Masts cause illness.",
      passage: "masts cause illness",
    });
  });

  it("shows the quotation in its exact, verified source revision", async () => {
    await extraction("p5");
    const archive = (hash: string) => ({
      lookupAt: async () => ({
        ref: { repository: "archive", commit: "a".repeat(40), path: "x", sha256: hash },
        content: JSON.stringify({ text: TEXT }),
      }),
    });
    const params = new URLSearchParams({
      result: "claim-extractions/pub/p5/full.json",
      category: "accepted",
      index: "0",
    });
    const loose = { ...archive("b".repeat(64)) };
    // A stand-in collection record: only `text` is read after schema parsing.
    const claims = savedClaims(content, {
      lookupAt: async (c: string, p: string) => {
        const r = await loose.lookupAt();
        return { ...r, content: JSON.stringify({ ...JSON.parse(r.content), _c: c, _p: p }) };
      },
    } as never);
    const row = await claims.detail("claim-extractions/pub/p5/full.json", "accepted", 0);
    expect(row?.sourceArtifact?.path).toBe("substack/pub/p5/collected.json");
    // A schema-valid archived capture at the pinned hash: the quote is highlighted.
    const record = JSON.stringify({
      item: { publicationId: "pub", postId: "p5", url: "https://pub.example.com/p/p5", title: "T" },
      ingestionReason: "backfill",
      text: TEXT,
      complete: true,
      supplied: {},
      provenance: {
        sourceUrl: "https://pub.example.com/p/p5",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        method: "article-html",
      },
    });
    const verified = {
      lookupAt: async () => ({
        ref: { repository: "archive", commit: "a".repeat(40), path: "x", sha256: "b".repeat(64) },
        content: record,
      }),
    };
    const [, , okSource] = claimViews(savedClaims(content, verified as never));
    const html = await okSource!.render(new URL(`http://x/claims/source?${params}`));
    expect(html).toContain(`<mark>${TEXT.slice(0, 30)}</mark>`);
    expect(html).toContain("verified against its recorded hash");
    // Unverifiable records (wrong hash, or not a collection record) are refused, never shown.
    const [, , source] = claimViews(savedClaims(content, archive("0".repeat(64)) as never));
    expect(await source!.render(new URL(`http://x/claims/source?${params}`))).toContain(
      "could not be read or verified",
    );
  });

  it("renders safely and distinguishes no matches from unavailable", async () => {
    await extraction("p2");
    const [list, detail] = claimViews(savedClaims(content));
    const html = await list!.render(new URL("http://x/claims?post=p2&category=candidate"));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; They knew.");
    expect(html).not.toContain("<script>");
    expect(html).toContain("never a verdict");
    const page = await detail!.render(
      new URL(
        `http://x/claims/view?${new URLSearchParams({ result: "claim-extractions/pub/p2/full.json", category: "accepted", index: "1" })}`,
      ),
    );
    expect(page).toContain("characters 120–151 of the source");
    expect(page).toContain("recovered by a formatting rule");
    expect(await list!.render(new URL("http://x/claims?q=nothing-here"))).toContain(
      "No saved claims match in this range.",
    );
    const [down] = claimViews(
      savedClaims({ list: async () => Promise.reject(new Error("x")) } as never),
    );
    expect(await down!.render(new URL("http://x/claims"))).toContain("unavailable right now");
  });
});
