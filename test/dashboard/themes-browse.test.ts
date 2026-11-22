import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { queryCollection } from "../../src/dashboard/collection-query.js";
import { themesBrowseViews } from "../../src/dashboard/themes-browse-views.js";
import { themesCollection } from "../../src/dashboard/themes-collection.js";
import { savedThemes } from "../../src/dashboard/themes.js";
import { DossierStore } from "../../src/research/dossier.js";
import { ThemeMappingCatalogue } from "../../src/research/theme-mappings.js";
import { ThemeStore } from "../../src/research/theme-store.js";
import { librarianFixtures } from "../research/librarian-fixtures.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-themes-browse-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const theme = (id: string, title: string, description?: string) =>
  new ThemeStore(content).ensure({
    id,
    title,
    ...(description ? { description } : {}),
    createdAt: "2026-01-01T00:00:00Z",
  });
const researched = (themeId: string) =>
  new DossierStore(content).save(
    {
      metadata: {
        schemaVersion: 1,
        themeId,
        title: `Dossier ${themeId}`,
        scope: "Synthetic",
        claims: [{ claimId: "c1", status: "covered", citations: ["who"] }],
        citations: [
          {
            id: "who",
            url: "https://who.example/x",
            title: "WHO",
            passage: "Below limits.",
            checkedAt: "2026-11-20",
          },
        ],
        gaps: [],
        updatedAt: "2026-11-20",
      },
      body: "Summary.",
    },
    undefined,
  );

const adapter = () => themesCollection(savedThemes(content), content);
const render = async (path: string) => {
  const url = new URL(`https://dashboard.test${path}`);
  return themesBrowseViews(savedThemes(content), content)[0]!.render(url);
};

describe("theme search (#618)", { timeout: 60_000 }, () => {
  it("lists canonical themes with coverage from actual dossier evidence, unresearched included", async () => {
    await theme("masts", "Phone masts");
    await theme("weather", "Weather warfare");
    await researched("masts");
    const all = await queryCollection(adapter(), { filters: { category: "canonical" } });
    expect(all.rows.map((r) => r.id).sort()).toEqual(["masts", "weather"]);
    const only = await queryCollection(adapter(), {
      filters: { category: "canonical", coverage: "unresearched" },
    });
    expect(only.rows.map((r) => r.id)).toEqual(["weather"]);
    // Exact saved version of the canonical record.
    expect(all.rows[0]!.artifact.path).toMatch(/^canonical-themes\//);
  });

  it("keeps proposals separate and shows their saved mapping status", async () => {
    const fx = librarianFixtures(content);
    await fx.analysis(
      "p1",
      [{ id: "c1", statement: "A treaty bans weather weapons" }],
      "Weather warfare",
    );
    await fx.analysis("p2", [{ id: "c2", statement: "Masts cause illness" }], "Phone masts");
    await theme("weather", "Weather warfare");
    await new ThemeMappingCatalogue(content).record({
      proposal: "Weather warfare",
      description: "Claims of weather modification as a weapon",
      canonicalThemeId: "weather",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: { publicationId: "pub", postId: "p1" },
      rationale: "same topic",
    });
    const proposals = await queryCollection(adapter(), { filters: { category: "proposal" } });
    expect(proposals.rows.every((r) => (r as { category: string }).category === "proposal")).toBe(
      true,
    );
    const mapped = await queryCollection(adapter(), {
      filters: { category: "proposal", mapping: "mapped" },
    });
    expect(mapped.rows.map((r) => r.summary)).toEqual(["Weather warfare"]);
    const unmapped = await queryCollection(adapter(), {
      filters: { category: "proposal", mapping: "unmapped" },
    });
    expect(unmapped.rows.map((r) => r.summary)).toEqual(["Phone masts"]);
    const html = await render("/themes/search?f.category=proposal&f.mapping=mapped");
    expect(html).toContain("mapped to");
    expect(html).toContain("/themes/canonical/view?id=weather");
  });

  it("reaches every canonical theme exactly once through the cursor with a small page", async () => {
    for (let i = 0; i < 5; i++) await theme(`t-${i}`, `Theme ${i}`);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await queryCollection(adapter(), {
        filters: { category: "canonical" },
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.next;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(["t-0", "t-1", "t-2", "t-3", "t-4"]);
  });

  it("refuses unknown filters, escapes hostile text and reports a cursor from another list", async () => {
    await theme("evil", '<script>alert("x")</script>', "<img src=x onerror=1>");
    const html = await render("/themes/search");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(await render("/themes/search?f.__proto__=x")).toContain("not valid");
    const first = await queryCollection(adapter(), {
      filters: { category: "canonical" },
      limit: 1,
    });
    await theme("second", "Second");
    const page = await queryCollection(adapter(), {
      filters: { category: "proposal" },
      ...(first.next ? { cursor: first.next } : { cursor: "bogus" }),
    });
    expect(page.limitations.join(" ")).toMatch(/not valid for this list/);
  });
});
