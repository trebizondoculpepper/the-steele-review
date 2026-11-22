import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { mappingViews } from "../../src/dashboard/mapping-views.js";
import { themeMappingCollection } from "../../src/dashboard/mappings.js";
import { queryCollection } from "../../src/dashboard/collection-query.js";
import { ThemeMappingCatalogue } from "../../src/research/theme-mappings.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-mappings-ui-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const by = { publicationId: "pub", postId: "p1" };
const source = {
  themeResult: {
    repository: "content",
    commit: "c".repeat(40),
    path: "theme-proposals/pub/p1/r.json",
    hash: `sha256:${"d".repeat(64)}`,
  },
  proposalId: "theme-1",
};

async function render(path: string): Promise<string> {
  const views = mappingViews(content);
  const url = new URL(`https://dashboard.test${path}`);
  return views.find((v) => v.path === url.pathname)!.render(url);
}

describe("theme mappings tab (#519)", { timeout: 60_000 }, () => {
  it("shows two known variants targeting one canonical theme", async () => {
    const catalogue = new ThemeMappingCatalogue(content);
    await catalogue.record({
      proposal: "Chemtrails",
      canonicalThemeId: "geoengineering",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: by,
      rationale: "same topic",
      method: "embedding",
      source,
    });
    await catalogue.record({
      proposal: "Chem trails over London",
      canonicalThemeId: "geoengineering",
      decidedAt: "2026-01-02T00:00:00Z",
      decidedBy: by,
      rationale: "variant",
      method: "lexical",
    });
    await catalogue.record({
      proposal: "Phone masts",
      canonicalThemeId: "masts",
      decidedAt: "2026-01-03T00:00:00Z",
      decidedBy: by,
      rationale: "other",
    });
    const page = await queryCollection(themeMappingCollection(content), {
      filters: { theme: "geoengineering" },
    });
    expect(page.rows.map((r) => r.summary).sort()).toEqual([
      "Chem trails over London",
      "Chemtrails",
    ]);
    const html = await render("/mappings?f.theme=geoengineering");
    expect(html).toContain("Chemtrails");
    expect(html).toContain("Chem trails over London");
    expect(html).not.toContain("Phone masts");
  });

  it("links a mapping to its exact version and source occurrence, and shows a pinned earlier version", async () => {
    const catalogue = new ThemeMappingCatalogue(content);
    const first = await catalogue.recordPinned({
      proposal: "Chemtrails",
      canonicalThemeId: "geoengineering",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: by,
      rationale: "same topic",
      method: "embedding",
      source,
    });
    await catalogue.correct({
      expected: first.ref,
      change: { canonicalThemeId: "weather-control" },
      reason: "split",
      correctedAt: "2026-02-01T00:00:00Z",
    });
    const current = await render(`/mappings/view?${new URLSearchParams({ path: first.ref.path })}`);
    expect(current).toContain("weather-control");
    expect(current).toContain("corrected");
    expect(current).toContain("split");
    expect(current).toContain(
      "/themes/view?result=theme-proposals%2Fpub%2Fp1%2Fr.json&amp;id=theme-1",
    );
    const pinned = await render(
      `/mappings/view?${new URLSearchParams({ path: first.ref.path, repository: first.ref.repository, commit: first.ref.commit, sha256: first.ref.sha256 })}`,
    );
    expect(pinned).toContain("geoengineering");
    expect(pinned).toContain("Pinned version");
  });

  it("keeps unresolved mappings identifiable and filterable", async () => {
    const catalogue = new ThemeMappingCatalogue(content);
    const first = await catalogue.recordPinned({
      proposal: "Mercury",
      canonicalThemeId: "mercury",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: by,
      rationale: "r",
    });
    await catalogue.correct({
      expected: first.ref,
      change: { unresolved: true },
      reason: "meaning changed",
      correctedAt: "2026-02-01T00:00:00Z",
    });
    const html = await render("/mappings?f.status=unresolved");
    expect(html).toContain("Mercury");
    expect(html).toContain("unresolved");
    const detail = await render(`/mappings/view?${new URLSearchParams({ path: first.ref.path })}`);
    expect(detail).toContain("not reused");
  });

  it("escapes malicious labels and refuses unknown filters", async () => {
    await new ThemeMappingCatalogue(content).record({
      proposal: '<script>alert("x")</script>',
      description: "<img src=x onerror=1>",
      canonicalThemeId: "evil",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: by,
      rationale: "<b>r</b>",
    });
    const html = await render("/mappings");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(await render("/mappings?f.__proto__=x")).toContain("not valid");
  });

  it("pages through the whole collection with a stable cursor", async () => {
    const catalogue = new ThemeMappingCatalogue(content);
    for (let i = 0; i < 7; i++) {
      await catalogue.record({
        proposal: `Wording ${i}`,
        canonicalThemeId: "t",
        decidedAt: `2026-01-0${i + 1}T00:00:00Z`,
        decidedBy: by,
        rationale: "r",
      });
    }
    const adapter = themeMappingCollection(content);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await queryCollection(adapter, { limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.rows.map((r) => r.summary));
      cursor = page.next;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe("Wording 6");
  });

  it("distinguishes an empty collection", async () => {
    expect(await render("/mappings")).toContain("No theme mappings have been saved yet.");
  });

  it("reports an unreadable repository as unavailable, not empty", async () => {
    const broken = {
      list: async () => {
        throw new Error("git failed");
      },
      lookup: async () => undefined,
      read: async () => "",
    };
    const html = await mappingViews(broken as never)
      .find((v) => v.path === "/mappings")!
      .render(new URL("https://dashboard.test/mappings"));
    expect(html).toContain("unavailable");
    expect(html).not.toContain("No theme mappings have been saved yet.");
  });
});
