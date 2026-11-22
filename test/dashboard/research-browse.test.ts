import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { savedResearch } from "../../src/dashboard/research.js";
import { researchBrowseViews } from "../../src/dashboard/research-browse-views.js";
import { DossierStore, type Dossier } from "../../src/research/dossier.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-research-browse-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const dossier = (id: string, title: string): Dossier => ({
  metadata: {
    schemaVersion: 1,
    themeId: id,
    title,
    scope: "Synthetic scope",
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
});

async function seed() {
  await new DossierStore(content).save(dossier("masts", "Masts dossier"), undefined);
  await content.write(
    "research-reports/site-a/topic-a/report.md",
    "# Imported treaty report\n\nImported summary.",
  );
  await content.write(
    `research-jobs/research-${"a".repeat(32)}/report.md`,
    "# <script>Generated report</script>\n\nGenerated summary.",
  );
}

const render = async (patch: string) => {
  const views = researchBrowseViews(savedResearch(content));
  const route = patch.split("?")[0]!;
  const view = views.find((v) => v.path === route)!;
  return view.render(new URL(`http://x${patch}`));
};

describe("research browser (#620)", { timeout: 60_000 }, () => {
  it("lists all three kinds distinctly with exact versions", async () => {
    await seed();
    const html = await render("/research/browse");
    expect(html).toContain("Masts dossier");
    expect(html).toContain("Imported treaty report");
    expect(html).toContain("generated report");
    expect(html).toContain("imported report");
    expect(html).toContain("dossier");
    // Opening a row pins the commit in the shared reader link.
    const ref = await content.lookup("dossier/masts.md");
    expect(html).toContain(`path=dossier%2Fmasts.md&amp;at=${ref!.commit}`);
    expect(html).toContain("not evidence that a claim is true");
    // Hostile generated title is escaped.
    expect(html).toContain("&lt;script&gt;Generated report");
    expect(html).not.toContain("<script>Generated report");
  });

  it("filters by kind, subject and dossier theme", async () => {
    await seed();
    expect((await render("/research/browse?f.kind=dossier")).match(/Masts dossier/g)).toHaveLength(1);
    const onlyDossier = await render("/research/browse?f.kind=dossier");
    expect(onlyDossier).toContain("Masts dossier");
    expect(onlyDossier).not.toContain("Imported treaty report");
    const theme = await render("/research/browse?f.theme=masts");
    expect(theme).toContain("Masts dossier");
    expect(theme).not.toContain("Generated report");
    const subject = await render("/research/browse?f.subject=topic-a");
    expect(subject).toContain("Imported treaty report");
    expect(subject).not.toContain("Masts dossier");
    const text = await render("/research/browse?q=generated");
    expect(text).toContain("Generated report");
    expect(text).not.toContain("Imported treaty report");
  });

  it("sorts deterministically and reaches every document through a cursor", async () => {
    await seed();
    const seen = new Set<string>();
    let page = await render("/research/browse?sort=path&limit=1");
    for (;;) {
      for (const m of page.matchAll(/\/research\/view\?path=([^&"]+)/g)) seen.add(m[1]!);
      const next = /after=([^"&]+)/.exec(page)?.[1];
      if (!next) break;
      page = await render(`/research/browse?sort=path&limit=1&after=${next}`);
      expect(seen.size).toBeLessThan(10);
    }
    expect(seen.size).toBe(3);
  });

  it("rejects unsupported filters/sorts and reports invalid page links safely", async () => {
    await seed();
    expect(await render("/research/browse?f.unknown=x")).toContain("not valid");
    expect(await render("/research/browse?sort=unknown")).toContain("not valid");
    const html = await render("/research/browse?after=not-a-cursor");
    expect(html).toContain("page link was not valid");
    expect(html).toContain("Masts dossier");
  });
});
