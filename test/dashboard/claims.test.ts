import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { claimViews } from "../../src/dashboard/claim-views.js";
import { savedClaims } from "../../src/dashboard/claims.js";
import { librarianFixtures } from "../research/librarian-fixtures.js";

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
    sourceVersion: `sha256:${"1".repeat(64)}`,
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
    rejected: [{ index: 3, reason: "passage-not-found" }],
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
