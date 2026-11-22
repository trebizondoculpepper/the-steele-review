import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { savedThemes } from "../../src/dashboard/themes.js";
import { themeViews } from "../../src/dashboard/theme-views.js";
import { DossierStore, type Dossier } from "../../src/research/dossier.js";
import { ThemeStore } from "../../src/research/theme-store.js";
import { ThemeMappingCatalogue } from "../../src/research/theme-mappings.js";
import { savedResearch } from "../../src/dashboard/research.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-canonical-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const decideBy = { publicationId: "pub", postId: "p1" };
const savedResearchPort = () => savedResearch(content);

async function theme(id: string, title: string, description?: string, createdAt = "2026-01-01T00:00:00Z") {
  const store = new ThemeStore(content);
  return store.ensure({
    id,
    title,
    ...(description ? { description } : {}),
    createdAt,
  });
}

async function dossier(themeId: string, mode: "researched" | "partial" | "gap" = "researched") {
  const claims =
    mode === "researched"
      ? [{ claimId: "c1", status: "covered" as const, citations: ["who"] }]
      : mode === "partial"
        ? [
            { claimId: "c1", status: "covered" as const, citations: ["who"] },
            { claimId: "c2", status: "gap" as const, reason: "nothing found" },
          ]
        : [{ claimId: "c1", status: "gap" as const, reason: "nothing found" }];
  const body: Dossier = {
    metadata: {
      schemaVersion: 1,
      themeId,
      title: `Dossier ${themeId}`,
      scope: "Synthetic",
      claims,
      citations: [
        {
          id: "who",
          url: "https://who.example/x",
          title: "WHO",
          passage: "Below limits.",
          checkedAt: "2026-11-20",
        },
      ],
      gaps: mode === "researched" ? [] : ["nothing found"],
      updatedAt: "2026-11-20",
    },
    body: "Summary.",
  };
  await new DossierStore(content).save(body, undefined);
}

const render = async (path: string, research?: boolean) => {
  const views = themeViews(
    savedThemes(content),
    research === false ? undefined : savedResearchPort(),
  );
  const route = path.split("?")[0]!;
  const view = views.find((v) => v.path === route)!;
  return view.render(new URL(`http://x${path}`));
};

describe("canonical themes browser (#517)", { timeout: 60_000 }, () => {
  it("shows researched and unresearched established themes", async () => {
    await theme("masts", "Phone masts", "Mast health claims");
    await theme("5g-health", "5G health concerns");
    await dossier("masts");

    const listing = await savedThemes(content).canonical({});
    expect(listing.state).toBe("ok");
    const byId = new Map(listing.rows.map((r) => [r.id, r]));
    expect(byId.get("masts")).toMatchObject({ title: "Phone masts", state: "researched" });
    expect(byId.get("masts")!.dossier).toMatchObject({ covered: 1, gaps: 0, citations: 1 });
    expect(byId.get("5g-health")).toMatchObject({ state: "unresearched" });
    expect(byId.get("5g-health")!.dossier).toBeUndefined();

    const html = await render("/themes/catalogue");
    expect(html).toContain("Phone masts");
    expect(html).toContain("5G health concerns");
    expect(html).toContain("no research yet");
    expect(html).toContain("researched");
  });

  it("filters by actual coverage and by title without merging themes", async () => {
    await theme("a", "Alpha topic");
    await theme("b", "Beta topic");
    await theme("c", "Alpha sibling");
    await dossier("b", "partial");

    const themes = savedThemes(content);
    expect((await themes.canonical({ coverage: "unresearched" })).rows.map((r) => r.id).sort()).toEqual([
      "a",
      "c",
    ]);
    expect(
      (await themes.canonical({ coverage: "partially-researched" })).rows.map((r) => r.id),
    ).toEqual(["b"]);
    // Overlapping wording stays two canonical identities.
    expect((await themes.canonical({ query: "alpha" })).rows.map((r) => r.id).sort()).toEqual([
      "a",
      "c",
    ]);
  });

  it("links a researched theme to its exact dossier and states an unresearched one honestly", async () => {
    await theme("masts", "Phone masts");
    await dossier("masts");
    await theme("5g-health", "5G health concerns");

    const researched = await render("/themes/canonical/view?id=masts");
    expect(researched).toContain("/research/view?path=dossier%2Fmasts.md&amp;at=");
    expect(researched).toContain("covered claim(s)");
    const log = await content.lookup("dossier/masts.md");
    expect(researched).toContain(log!.commit);

    const unresearched = await render("/themes/canonical/view?id=5g-health");
    expect(unresearched).toContain("no research has been saved for this theme yet");
    expect(unresearched).not.toContain("/research/view");
  });

  it("resolves mapped proposals through saved librarian mappings and supersession", async () => {
    await theme("masts", "Phone masts");
    await theme("other", "Other topic");
    const catalogue = new ThemeMappingCatalogue(content);
    await catalogue.record({
      proposal: "Phone mast syndrome",
      canonicalThemeId: "masts",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: decideBy,
      rationale: "same established topic",
    });
    await catalogue.record({
      proposal: "Old masts wording",
      canonicalThemeId: "legacy-masts",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: decideBy,
      rationale: "earlier identity",
    });
    await catalogue.supersede({
      proposal: "Old masts wording",
      from: "legacy-masts",
      to: "masts",
      reason: "canonical merge",
      decidedAt: "2026-01-02T00:00:00Z",
      decidedBy: decideBy,
    });
    await catalogue.record({
      proposal: "Unrelated",
      canonicalThemeId: "other",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: decideBy,
      rationale: "different topic",
    });

    const detail = await savedThemes(content).canonicalDetail("masts");
    expect(detail?.proposals.map((p) => p.proposal).sort()).toEqual([
      "Old masts wording",
      "Phone mast syndrome",
    ]);
    expect(detail?.proposals.every((p) => p.decidedBy.publicationId === "pub")).toBe(true);
    const html = await render("/themes/canonical/view?id=masts");
    expect(html).toContain("Phone mast syndrome");
    expect(html).toContain("Old masts wording");
    expect(html).not.toContain("Unrelated");
    expect(html).toContain("not UI string merging");
  });

  it("reaches the whole catalogue through bounded pagination", async () => {
    for (let i = 0; i < 27; i++) {
      await theme(`t-${String(i).padStart(2, "0")}`, `Theme ${i}`);
    }
    const themes = savedThemes(content);
    const first = await themes.canonical({});
    expect(first.rows).toHaveLength(25);
    expect(first.next).toBeDefined();
    const second = await themes.canonical({ after: first.next });
    expect(second.rows).toHaveLength(2);
    expect(second.next).toBeUndefined();
    const ids = new Set([...first.rows, ...second.rows].map((r) => r.id));
    expect(ids.size).toBe(27);
  });

  it("escapes untrusted theme and proposal text", async () => {
    await theme("x", "<script>alert(1)</script>");
    const catalogue = new ThemeMappingCatalogue(content);
    await catalogue.record({
      proposal: "<b>mast</b> wording",
      canonicalThemeId: "x",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: decideBy,
      rationale: "<i>because</i>",
    });
    const listing = await render("/themes/catalogue");
    expect(listing).toContain("&lt;script&gt;");
    expect(listing).not.toContain("<script>");
    const detail = await render("/themes/canonical/view?id=x");
    expect(detail).toContain("&lt;b&gt;mast&lt;/b&gt;");
    expect(detail).not.toContain("<b>mast</b>");
  });

  it("returns nothing for an unknown canonical id", async () => {
    expect(await savedThemes(content).canonicalDetail("does-not-exist")).toBeUndefined();
    expect(await render("/themes/canonical/view?id=does-not-exist")).toContain(
      "Choose a canonical theme",
    );
  });
});

describe("canonical mapping resolution (#517)", { timeout: 60_000 }, () => {
  it("follows a redirect chain to the current canonical identity", async () => {
    await theme("c", "Final topic");
    const catalogue = new ThemeMappingCatalogue(content);
    await catalogue.record({
      proposal: "Chained wording",
      canonicalThemeId: "a",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: decideBy,
      rationale: "initial",
    });
    // Record B→C before A→B; the newest-event-per-proposal shortcut would
    // resolve A→B and miss C.
    await catalogue.supersede({
      proposal: "Chained wording",
      from: "b",
      to: "c",
      reason: "merge",
      decidedAt: "2026-01-02T00:00:00Z",
      decidedBy: decideBy,
    });
    await catalogue.supersede({
      proposal: "Chained wording",
      from: "a",
      to: "b",
      reason: "rename",
      decidedAt: "2026-01-03T00:00:00Z",
      decidedBy: decideBy,
    });
    const detail = await savedThemes(content).canonicalDetail("c");
    expect(detail?.proposals.map((p) => p.proposal)).toEqual(["Chained wording"]);
    expect(await savedThemes(content).canonicalDetail("a")).toBeUndefined();
  });

  it("orders supersession timestamps by instant, not text", async () => {
    await theme("later", "Later target");
    const catalogue = new ThemeMappingCatalogue(content);
    await catalogue.record({
      proposal: "Offset wording",
      canonicalThemeId: "start",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: decideBy,
      rationale: "initial",
    });
    // 23:00Z is later than 00:30+02:00 (22:30Z), though it sorts earlier as text.
    await catalogue.supersede({
      proposal: "Offset wording",
      from: "start",
      to: "earlier",
      reason: "earlier correction",
      decidedAt: "2026-01-02T00:30:00+02:00",
      decidedBy: decideBy,
    });
    await catalogue.supersede({
      proposal: "Offset wording",
      from: "start",
      to: "later",
      reason: "later correction",
      decidedAt: "2026-01-01T23:00:00Z",
      decidedBy: decideBy,
    });
    const detail = await savedThemes(content).canonicalDetail("later");
    expect(detail?.proposals.map((p) => p.proposal)).toEqual(["Offset wording"]);
  });
});

describe("legacy catalogue transition (#517)", { timeout: 60_000 }, () => {
  it("keeps the earlier detected catalogue separately accessible", async () => {
    await content.revise(
      "catalogue/themes.json",
      JSON.stringify({
        schemaVersion: 1,
        themes: [
          {
            id: "masts",
            name: "Phone masts",
            definition: "Health claims about masts.",
            aliases: ["mast syndrome"],
            origin: "detected",
          },
        ],
      }),
      null,
    );
    // No canonical-theme records exist yet: the new page must not pretend the
    // old, still-consumed catalogue vanished.
    const empty = await render("/themes/catalogue");
    expect(empty).toContain("No canonical themes have been established yet");
    expect(empty).toContain('href="/themes/catalogue/legacy"');

    const legacy = await render("/themes/catalogue/legacy");
    expect(legacy).toContain("Phone masts");
    expect(legacy).toContain("not the librarian's canonical authority");
  });
});

describe("canonical supersession fidelity (#517)", { timeout: 60_000 }, () => {
  it("normalises scope spellings like the librarian does", async () => {
    await theme("b", "Scoped target");
    const catalogue = new ThemeMappingCatalogue(content);
    await catalogue.record({
      proposal: "Scoped wording",
      description: "A scoped topic",
      scope: "Science Desk",
      canonicalThemeId: "a",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: decideBy,
      rationale: "initial",
    });
    await catalogue.supersede({
      proposal: "Scoped wording",
      description: "A scoped topic",
      scope: "science-desk",
      from: "a",
      to: "b",
      reason: "canonical correction",
      decidedAt: "2026-01-02T00:00:00Z",
      decidedBy: decideBy,
    });
    // The librarian's own lookup already resolves this to b.
    expect(
      (await catalogue.lookup({ proposal: "Scoped wording", description: "A scoped topic", scope: "Science Desk" }))
        ?.canonicalThemeId,
    ).toBe("b");
    const detail = await savedThemes(content).canonicalDetail("b");
    expect(detail?.proposals.map((p) => p.proposal)).toEqual(["Scoped wording"]);
  });

  it("keeps the same tie-break as the librarian for identical timestamps", async () => {
    await theme("b", "Tie target B");
    await theme("c", "Tie target C");
    const catalogue = new ThemeMappingCatalogue(content);
    await catalogue.record({
      proposal: "Tied wording",
      canonicalThemeId: "a",
      decidedAt: "2026-01-01T00:00:00Z",
      decidedBy: decideBy,
      rationale: "initial",
    });
    const at = "2026-01-02T00:00:00Z";
    await catalogue.supersede({
      proposal: "Tied wording",
      from: "a",
      to: "b",
      reason: "first decision",
      decidedAt: at,
      decidedBy: decideBy,
    });
    await catalogue.supersede({
      proposal: "Tied wording",
      from: "a",
      to: "c",
      reason: "second decision, same instant",
      decidedAt: at,
      decidedBy: decideBy,
    });
    const expected = (
      await catalogue.lookup({ proposal: "Tied wording" })
    )?.canonicalThemeId;
    expect(["b", "c"]).toContain(expected);
    const detail = await savedThemes(content).canonicalDetail(expected!);
    expect(detail?.proposals.map((p) => p.proposal)).toEqual(["Tied wording"]);
    const other = expected === "b" ? "c" : "b";
    expect((await savedThemes(content).canonicalDetail(other))?.proposals ?? []).toEqual([]);
  });
});

describe("theme research documents (#516)", { timeout: 60_000 }, () => {
  const job = (hex: string, themeIds: string[], report?: string) => ({
    requestPath: `research-jobs/research-${hex}/request.json`,
    reportPath: `research-jobs/research-${hex}/report.md`,
    themeIds,
    report,
  });

  async function writeJob(
    j: ReturnType<typeof job>,
  ) {
    await content.write(
      j.requestPath,
      JSON.stringify({
        schemaVersion: 1,
        origin: "manual",
        subject: "Synthetic subject",
        question: "Does this theme hold up?",
        pass: 1,
        claims: j.themeIds.map((id, i) => ({
          claimRecordId: `claim-${i}`,
          statement: "Synthetic claim",
          themeIds: [id],
        })),
        corpusRefs: [],
      }),
    );
    if (j.report !== undefined) await content.write(j.reportPath, j.report);
  }

  it("lists the dossier and every associated saved report with exact versions", async () => {
    await theme("masts", "Phone masts");
    await dossier("masts");
    await writeJob(job("a".repeat(32), ["masts"], "# Report one\n\nSummary of one."));
    await writeJob(job("b".repeat(32), ["other"], "# Unrelated\n\nNot this theme."));
    await writeJob(job("c".repeat(32), ["masts"], "# Report two\n\nSummary of two."));

    const html = await render("/themes/canonical/view?id=masts");
    expect(html).toContain("Dossier masts");
    expect(html).toContain("Report one");
    expect(html).toContain("Report two");
    expect(html).not.toContain("Unrelated");
    // Each document opens the exact pinned revision through the #507 reader.
    const report = await content.lookup(`research-jobs/research-${"c".repeat(32)}/report.md`);
    expect(html).toContain(encodeURIComponent(`research-jobs/research-${"c".repeat(32)}/report.md`));
    expect(html).toContain(`at=${report!.commit}`);
    expect(html).toContain("no date recorded");
    expect(html).toContain("Only saved librarian/theme/dossier associations are listed");
    expect(html).toContain("Does this theme hold up?");
  });

  it("distinguishes no linked documents from unavailable research", async () => {
    await theme("lonely", "Lonely theme");
    const none = await render("/themes/canonical/view?id=lonely");
    expect(none).toContain("No saved research documents are linked to this theme yet");
    expect(none).toContain("/research");

    const unavailable = await render("/themes/canonical/view?id=lonely", false);
    expect(unavailable).toContain("Saved research documents are unavailable");
    expect(unavailable).not.toContain("No saved research documents");
  });

  it("paginates a long document list and escapes untrusted report text", async () => {
    await theme("masts", "Phone masts");
    await dossier("masts");
    for (let i = 0; i < 22; i++) {
      await writeJob(
        job(
          String(i).padStart(2, "0").repeat(16),
          ["masts"],
          `# <script>Report ${i}</script>\n\nBody ${i}`,
        ),
      );
    }
    const first = await render("/themes/canonical/view?id=masts");
    expect(first).toContain("More documents");
    expect(first).toContain("&lt;script&gt;Report");
    expect(first).not.toContain("<script>Report");
    const next = /after=([^"&]+)/.exec(first)?.[1];
    expect(next).toBeDefined();
    const second = await render(`/themes/canonical/view?id=masts&after=${next}`);
    expect(second).toContain("Report 21");
    expect(second).not.toContain("More documents");
    // The dossier is listed once, not repeated on continuation pages.
    expect(first).toContain("Dossier masts");
    expect(second).not.toContain("Dossier masts");
  });

  it("pins the document version rather than substituting current text", async () => {
    await theme("masts", "Phone masts");
    await writeJob(job("d".repeat(32), ["masts"], "# Old title\n\nOld body."));
    // A later revision of the same report path does not change the listed ref
    // in an already-rendered page; the link carries the exact commit.
    const listing = await savedResearchPort().forTheme("masts");
    const doc = listing.docs.find((d) => d.path.endsWith("report.md"))!;
    expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
