import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { claimBrowseViews } from "../../src/dashboard/claim-browse-views.js";
import { savedClaims } from "../../src/dashboard/claims.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { TEXT, librarianFixtures } from "../research/librarian-fixtures.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-claim-browse-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const occurrence = (passage: string, start: number) => ({
  passage,
  span: { start, end: start + passage.length },
  speaker: { kind: "author-voice" },
  sourcePublishedAt: "2026-01-02T00:00:00Z",
  occurrenceId: `sha256:${String(start).padStart(64, "0")}`,
});

async function extraction(postId: string) {
  const fx = librarianFixtures(content);
  const { themeResult } = await fx.analysis(postId, [{ id: "seed", statement: "seed" }]);
  const theme = JSON.parse(await content.read(themeResult));
  const themeId = theme.proposals[0].id as string;
  const record = {
    schemaVersion: 3,
    post: { publicationId: "pub", postId },
    sourceVersion: sourceVersionFor(TEXT),
    themeIds: [themeId],
    themeResult: `${themeResult.commit}:${themeResult.path}`,
    claims: [
      {
        claim: { statement: "A treaty bans weather weapons." },
        occurrence: occurrence("A treaty bans weather weapons.", 0),
        kind: "assertion",
        themeIds: [themeId],
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
    rejected: [{ index: 3, reason: "passage-not-found" }],
    extraction: { modelVersion: "fake/m", promptVersion: "p", extractedAt: "2026-01-03T00:00:00Z" },
  };
  await content.write(`claim-extractions/pub/${postId}/full.json`, JSON.stringify(record));
  return themeId;
}

const render = async (patch: string) => {
  const views = claimBrowseViews(content, savedClaims(content));
  const route = patch.split("?")[0]!;
  const view = views.find((v) => v.path === route)!;
  return view.render(new URL(`http://x${patch}`));
};

describe("claim browser (#619)", { timeout: 60_000 }, () => {
  it("lists accepted, candidate and rejected rows distinctly with exact versions", async () => {
    await extraction("p1");
    const html = await render("/claims/browse");
    expect(html).toContain("A treaty bans weather weapons.");
    expect(html).toContain(">accepted<");
    expect(html).toContain(">candidate<");
    expect(html).toContain(">rejected<");
    expect(html).toContain("claim-extractions%2Fpub%2Fp1%2Ffull.json");
    const ref = await content.lookup("claim-extractions/pub/p1/full.json");
    expect(html).toContain(ref!.commit.slice(0, 12));
    // Candidate wording is escaped.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("links each row to its exact saved claim detail", async () => {
    await extraction("p1");
    const html = await render("/claims/browse");
    expect(html).toContain(
      "/claims/view?result=claim-extractions%2Fpub%2Fp1%2Ffull.json&amp;category=accepted&amp;index=0",
    );
    expect(html).toContain("&amp;category=candidate&amp;index=0");
    expect(html).toContain("&amp;category=rejected&amp;index=0");
    expect(html).toContain("none of this is a truth or research verdict");
  });

  it("filters by category, post, theme and text", async () => {
    const themeId = await extraction("p1");
    const candidate = await render("/claims/browse?f.category=candidate");
    expect(candidate).toContain("They knew.");
    expect(candidate).not.toContain("A treaty bans weather weapons.");
    const post = await render("/claims/browse?f.post=p1");
    expect(post).toContain("A treaty bans weather weapons.");
    const theme = await render(`/claims/browse?f.theme=${themeId}`);
    expect(theme).toContain("A treaty bans weather weapons.");
    const text = await render("/claims/browse?q=treaty");
    expect(text).toContain("A treaty bans weather weapons.");
    expect(text).not.toContain("They knew.");
  });

  it("reaches every row through bounded continuation", async () => {
    await extraction("p1");
    const seen = new Set<string>();
    let page = await render("/claims/browse?limit=1");
    for (;;) {
      for (const m of page.matchAll(/href="(\/claims\/view\?[^"]+)"/g)) seen.add(m[1]!);
      const next = /after=([^"&]+)/.exec(page)?.[1];
      if (!next) break;
      page = await render(`/claims/browse?limit=1&after=${next}`);
      expect(seen.size).toBeLessThan(10);
    }
    // The fixture analysis also saves a seed extraction; every row is reachable.
    expect(seen.size).toBe(4);
  });

  it("refuses unsupported filters and reports a bad cursor without hiding results", async () => {
    await extraction("p1");
    expect(await render("/claims/browse?f.unknown=x")).toContain("not valid");
    expect(await render("/claims/browse?sort=title")).toContain("not valid");
    const html = await render("/claims/browse?after=not-a-cursor");
    expect(html).toContain("page link was not valid");
    expect(html).toContain("A treaty bans weather weapons.");
  });
});
