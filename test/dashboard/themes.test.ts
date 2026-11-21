import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { themeViews } from "../../src/dashboard/theme-views.js";
import { savedThemes } from "../../src/dashboard/themes.js";
import { librarianFixtures } from "../research/librarian-fixtures.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-themes-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const claim = (id: string, statement: string) => [{ id, statement }];

describe("themes browser (#493)", { timeout: 60_000 }, () => {
  it("keeps overlapping themes from different posts separate and traceable", async () => {
    const fx = librarianFixtures(content);
    await fx.analysis("p1", claim("c1", "A treaty bans weather weapons"), "Weather warfare");
    await fx.analysis("p2", claim("c2", "Clouds are seeded to cause floods"), "Weather warfare");
    const themes = savedThemes(content);
    const listing = await themes.list({});
    expect(listing.state).toBe("ok");
    const weather = listing.rows.filter((r) => r.title === "Weather warfare");
    expect(weather.map((r) => r.postId).sort()).toEqual(["p1", "p2"]);
    expect(new Set(weather.map((r) => r.result)).size).toBe(2);

    // Detail: only claims from this exact saved extraction link the proposal.
    const p1 = weather.find((r) => r.postId === "p1")!;
    const detail = await themes.detail(p1.result, p1.id);
    expect(detail?.claims.map((c) => c.statement)).toEqual(["A treaty bans weather weapons"]);
    const [, view] = themeViews(themes);
    const html = await view!.render(
      new URL(`http://x/themes/view?${new URLSearchParams({ result: p1.result, id: p1.id })}`),
    );
    expect(html).toContain("/articles/trace?publication=pub&amp;post=p1");
    expect(html).toContain("not a canonical theme");
  });

  it("escapes hostile labels, filters, and distinguishes empty from unavailable", async () => {
    const fx = librarianFixtures(content);
    await fx.analysis("p3", claim("c3", "x"), "<img src=x onerror=alert(1)> Masts");
    const [list] = themeViews(savedThemes(content));
    const html = await list!.render(new URL("http://x/themes"));
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; Masts");
    expect(html).not.toContain("<img");
    expect(await list!.render(new URL("http://x/themes?q=nothing-matches"))).toContain(
      "No saved themes match this filter.",
    );
    const broken = { list: async () => Promise.reject(new Error("down")) } as never;
    const [down] = themeViews(savedThemes(broken));
    expect(await down!.render(new URL("http://x/themes"))).toContain("unavailable right now");
    await mkdir(join(dir, "empty"));
    const empty = new GitArtifactStore({ repoPath: join(dir, "empty"), repository: "e" });
    await empty.initialise();
    const [none] = themeViews(savedThemes(empty));
    expect(await none!.render(new URL("http://x/themes"))).toContain("No saved themes yet.");
  });

  it("pages by cursor through every saved extraction", async () => {
    const fx = librarianFixtures(content);
    for (let i = 0; i < 30; i++) {
      await fx.analysis(
        `post-${String(i).padStart(2, "0")}`,
        claim(`c${i}`, `s${i}`),
        `Theme ${String(i).padStart(2, "0")}`,
      );
    }
    const themes = savedThemes(content);
    const first = await themes.list({});
    expect(first.rows).toHaveLength(25);
    expect(first.next).toBeTruthy();
    const second = await themes.list({ after: first.next! });
    expect(second.rows).toHaveLength(5);
    expect(second.next).toBeUndefined();
    expect(new Set([...first.rows, ...second.rows].map((r) => `${r.result}#${r.id}`)).size).toBe(
      30,
    );
  });

  it("reaches a filter match that lies beyond the per-request scan limit", async () => {
    const fx = librarianFixtures(content);
    await fx.analysis("seed", claim("c0", "s0"), "Ordinary");
    const [seedPath] = await content.list("theme-proposals/pub/seed", 5);
    const template = JSON.parse(await content.read((await content.lookup(seedPath!))!));
    // Five saved extractions in storage order; only the last one matches. A
    // small scan limit exercises the same cursor logic without hundreds of
    // Git commits (which made this test exceed its timeout under load).
    for (let i = 0; i < 5; i++) {
      const postId = `p${String(i).padStart(3, "0")}`;
      const doc = structuredClone(template);
      doc.post.postId = postId;
      doc.proposals = [
        { ...doc.proposals[0], title: i === 4 ? "Hidden needle" : `Ordinary ${i}` },
      ];
      await content.write(`theme-proposals/pub/${postId}/x.json`, JSON.stringify(doc));
    }
    const themes = savedThemes(content, { scanLimit: 2 });
    let page = await themes.list({ query: "needle" });
    const found: string[] = [];
    for (let i = 0; i < 10; i++) {
      found.push(...page.rows.map((r) => r.title));
      if (!page.next) break;
      page = await themes.list({ query: "needle", after: page.next });
    }
    expect(found).toEqual(["Hidden needle"]);
  });
});
