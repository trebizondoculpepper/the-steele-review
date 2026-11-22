import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { savedThemes } from "../../src/dashboard/themes.js";
import { savedResearch } from "../../src/dashboard/research.js";
import { dossierViews } from "../../src/dashboard/dossier-views.js";
import { DossierStore, type Dossier } from "../../src/research/dossier.js";
import { ThemeStore } from "../../src/research/theme-store.js";
import { researchJobId } from "../../src/research/job.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-dossiers-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const theme = async (id: string, title: string) =>
  new ThemeStore(content).ensure({ id, title, createdAt: "2026-01-01T00:00:00Z" });

async function saveDossier(
  id: string,
  covered: boolean,
  gapQuote = "Nothing found.",
  withGap = false,
) {
  const body: Dossier = {
    metadata: {
      schemaVersion: 1,
      themeId: id,
      title: `Dossier ${id}`,
      scope: `Scope of ${id}`,
      claims: covered
        ? [
            { claimId: "c1", status: "covered", citations: ["who"] },
            ...(withGap
              ? [{ claimId: "c2", status: "gap" as const, reason: gapQuote }]
              : []),
          ]
        : [{ claimId: "c1", status: "gap", reason: gapQuote }],
      citations: [
        {
          id: "who",
          url: "https://who.example/x",
          title: "<b>WHO</b>",
          passage: "<script>alert(1)</script> Below limits.",
          checkedAt: "2026-11-20",
        },
      ],
      gaps: covered && !withGap ? [] : [gapQuote],
      updatedAt: "2026-11-20",
    },
    body: "Dossier summary.",
  };
  await new DossierStore(content).save(body, undefined);
}

async function linkedJob(themeId: string) {
  const request = {
    schemaVersion: 1,
    origin: "manual" as const,
    subject: "Associated research",
    question: "What does the evidence show?",
    pass: 1,
    claims: [{ claimRecordId: "c1", statement: "A claim", themeIds: [themeId] }],
    corpusRefs: [],
  };
  const jobId = researchJobId(request);
  await content.write(`research-jobs/${jobId}/request.json`, JSON.stringify(request));
  await content.write(`research-jobs/${jobId}/report.md`, "# Associated report\n\nBody.");
  return jobId;
}

const render = async (path: string) => {
  const views = dossierViews(savedThemes(content), savedResearch(content));
  const route = path.split("?")[0]!;
  const view = views.find((v) => v.path === route)!;
  return view.render(new URL(`http://x${path}`));
};

describe("dossiers section (#532)", { timeout: 60_000 }, () => {
  it("lists only themes with actual dossiers and links their collections", async () => {
    await theme("masts", "Phone masts");
    await theme("5g", "5G health");
    await saveDossier("masts", true);
    await linkedJob("masts");

    const listing = await render("/dossiers");
    expect(listing).toContain("Phone masts");
    expect(listing).not.toContain("5G health");
    expect(listing).toContain("1 covered / 0 gap(s) / 1 citation(s)");
    expect(listing).toContain('/dossiers/view?theme=masts');
    expect(listing).toContain("Themes without a dossier");
  });

  it("opens the exact dossier version with coverage, citations, gaps and documents", async () => {
    await theme("masts", "Phone masts");
    await saveDossier("masts", true, "No independent evidence found.", true);
    const jobId = await linkedJob("masts");
    const ref = await content.lookup("dossier/masts.md");

    const html = await render("/dossiers/view?theme=masts");
    expect(html).toContain("Dossier masts");
    expect(html).toContain(ref!.commit);
    expect(html).toContain("c1");
    expect(html).toContain("gap");
    expect(html).toContain("No independent evidence found.");
    expect(html).toContain("https://who.example/x");
    expect(html).toContain("Associated report");
    expect(html).toContain(jobId);
    // Citation ids are shown and linked from the coverage reference.
    expect(html).toContain('id="citation-who"');
    expect(html).toContain('href="#citation-who"');
    expect(html).toContain("a citation is not evidence that a claim is true");
    // Source content is escaped, never executed.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("states an unresearched theme honestly instead of an empty dossier", async () => {
    await theme("5g", "5G health");
    const html = await render("/dossiers/view?theme=5g");
    expect(html).toContain("no saved dossier yet");
    expect(html).not.toContain("Dossier text");
  });

  it("handles unknown and malformed selections", async () => {
    expect(await render("/dossiers/view?theme=unknown")).toContain("Choose a dossier");
    expect(await render("/dossiers/view?theme=../escape")).toContain("Choose a dossier");
  });
});

describe("dossier document continuation (#532)", { timeout: 60_000 }, () => {
  it("offers continuation when a dossier has many associated reports", async () => {
    await theme("masts", "Phone masts");
    await saveDossier("masts", true);
    for (let i = 0; i < 21; i++) {
      const request = {
        schemaVersion: 1,
        origin: "manual" as const,
        subject: `Research ${i}`,
        question: `Question ${i}`,
        pass: 1,
        claims: [{ claimRecordId: "c1", statement: "A claim", themeIds: ["masts"] }],
        corpusRefs: [],
      };
      const jobId = researchJobId(request);
      await content.write(`research-jobs/${jobId}/request.json`, JSON.stringify(request));
      await content.write(`research-jobs/${jobId}/report.md`, `# Report ${i}\n\nBody.`);
    }
    const first = await render("/dossiers/view?theme=masts");
    expect(first).toContain("More documents");
    const more = /after=([^"&]+)[^>]*>More documents/.exec(first);
    expect(more).not.toBeNull();
    const next = more![1]!;
    const second = await render(`/dossiers/view?theme=masts&after=${next}`);
    expect(second).not.toContain("More documents");
  });

  it("distinguishes an unavailable document listing from an empty one", async () => {
    await theme("masts", "Phone masts");
    await saveDossier("masts", true);
    const failing = {
      forTheme: async () => ({ state: "unavailable" as const, docs: [], truncated: false }),
      detail: savedResearch(content).detail.bind(savedResearch(content)),
      list: savedResearch(content).list.bind(savedResearch(content)),
    };
    const views = dossierViews(savedThemes(content), failing as never);
    const view = views.find((v) => v.path === "/dossiers/view")!;
    const html = await view.render(new URL("http://x/dossiers/view?theme=masts"));
    expect(html).toContain("associated document list is unavailable");
    expect(html).not.toContain("No other saved documents are associated");
  });
});
