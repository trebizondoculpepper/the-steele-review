import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { renderDossier } from "../../src/research/dossier.js";
import { savedResearch } from "../../src/dashboard/research.js";
import { researchViews } from "../../src/dashboard/research-views.js";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-research-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const JOB = `research-${"a".repeat(32)}`;

async function corpus() {
  await content.write(
    "research-reports/manual/5g/one.md",
    "# 5G primer\n\nNewer version <script>alert(1)</script>. See [x](javascript:alert(1)).",
  );
  // An overlapping subject from another report.
  await content.write("research-reports/manual/5g/two.md", "# 5G second look\n\nMasts.");
  await content.write(
    `research-jobs/${JOB}/request.json`,
    JSON.stringify({
      schemaVersion: 1,
      origin: "manual",
      subject: "5G towers",
      pass: 1,
      claims: [],
      corpusRefs: [],
    }),
  );
  const report = await content.write(
    `research-jobs/${JOB}/report.json`,
    JSON.stringify({
      schemaVersion: 1,
      jobId: JOB,
      promptVersion: "p",
      model: "fake/sonar",
      report: "# Generated 5G report\n\nFindings.",
      citations: ["https://a.example/x", "https://b.example/y"],
    }),
  );
  const ref = {
    repository: "content",
    commit: report.commit,
    path: report.path,
    hash: `sha256:${report.sha256}`,
  };
  const manifest = await content.write(
    `research-jobs/${JOB}/manifest.json`,
    JSON.stringify({
      schemaVersion: 1,
      jobId: JOB,
      report: ref,
      citations: [
        { url: "https://a.example/x", retrieval: "archived", support: "unverified", passages: [] },
        { url: "https://b.example/y", retrieval: "inaccessible", passages: [] },
      ],
      gaps: ["No primary source for the tower claim."],
      provider: { model: "fake/sonar" },
    }),
  );
  await content.write(
    `research-jobs/${JOB}/result.json`,
    JSON.stringify({
      schemaVersion: 1,
      jobId: JOB,
      outcome: "complete-with-gaps",
      manifest: {
        ...ref,
        path: manifest.path,
        commit: manifest.commit,
        hash: `sha256:${manifest.sha256}`,
      },
      finishedAt: "2026-11-20T10:00:00Z",
    }),
  );
  const v1 = await content.revise(
    "dossier/fivegee.md",
    renderDossier({
      metadata: {
        schemaVersion: 1,
        themeId: "fivegee",
        title: "5G dossier",
        scope: "5G as a weapon",
        claims: [],
        citations: [],
        gaps: [],
        updatedAt: "2026-11-19",
      },
      body: "Curated summary, older version.",
    }),
    null,
  );
  await content.revise(
    "dossier/fivegee.md",
    renderDossier({
      metadata: {
        schemaVersion: 1,
        themeId: "fivegee",
        title: "5G dossier",
        scope: "5G as a weapon",
        claims: [],
        citations: [],
        gaps: [],
        updatedAt: "2026-11-20",
      },
      body: "Curated summary, current.",
    }),
    v1.sha256,
  );
  return { v1 };
}

describe("research browser (#507)", { timeout: 60_000 }, () => {
  it("keeps kinds, versions and citation limits distinct", async () => {
    const { v1 } = await corpus();
    const research = savedResearch(content);
    const rows = (await research.list({})).rows;
    expect(rows.map((r) => [r.kind, r.title])).toEqual([
      ["dossier", "5G dossier"],
      ["generated-report", "Generated 5G report"],
      ["imported-report", "5G primer"],
      ["imported-report", "5G second look"],
    ]);
    const job = rows.find((r) => r.kind === "generated-report")!;
    expect(job).toMatchObject({
      subject: "5G towers",
      outcome: "complete-with-gaps",
      citationCount: 2,
    });
    // Imports have no structured citations: shown as not recorded, never guessed.
    expect(rows.find((r) => r.title === "5G primer")!.citationCount).toBeUndefined();
    // The older version stays readable at its own commit.
    const old = await research.detail("dossier/fivegee.md", v1.commit);
    expect(old?.text).toContain("older version");
    expect((await research.detail("dossier/fivegee.md", rows[0]!.commit))?.text).toContain(
      "current",
    );
    const kindOnly = await research.list({ kind: "imported-report", query: "masts" });
    expect(kindOnly.rows.map((r) => r.title)).toEqual(["5G second look"]);
  });

  it("renders hostile content safely and never upgrades citations to evidence", async () => {
    await corpus();
    const [list, detail] = researchViews(savedResearch(content));
    const head = (await savedResearch(content).list({ query: "newer" })).rows[0]!;
    const page = await detail!.render(
      new URL(
        `http://x/research/view?${new URLSearchParams({ path: head.path, at: head.commit })}`,
      ),
    );
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).not.toContain("<script>");
    expect(page).toContain("no structured citations were recorded");
    const old = await detail!.render(
      new URL(
        `http://x/research/view?${new URLSearchParams({ path: head.path, at: head.commit })}`,
      ),
    );
    expect(old).not.toContain('href="javascript');
    const job = (await savedResearch(content).list({ kind: "generated-report" })).rows[0]!;
    const jobPage = await detail!.render(
      new URL(`http://x/research/view?${new URLSearchParams({ path: job.path, at: job.commit })}`),
    );
    expect(jobPage).toContain("not verified evidence");
    expect(jobPage).not.toContain("an archived passage supports");
    expect(jobPage).toContain("No primary source for the tower claim.");
    expect(await list!.render(new URL("http://x/research?q=zzz"))).toContain(
      "No saved research matches in this range.",
    );
    expect(
      await detail!.render(
        new URL("http://x/research/view?path=dossier/nope.md&at=" + "0".repeat(40)),
      ),
    ).toContain("missing or could not be read");
    const [down] = researchViews(
      savedResearch({ list: async () => Promise.reject(new Error("x")) } as never),
    );
    expect(await down!.render(new URL("http://x/research"))).toContain("unavailable right now");
  });

  it("reaches a match beyond the first bounded scan window", async () => {
    for (let i = 0; i < 205; i++) {
      await content.write(
        `research-reports/manual/bulk/${String(i).padStart(3, "0")}.md`,
        `# Report ${i}\n\n${i === 204 ? "hidden needle" : "filler"}`,
      );
    }
    const research = savedResearch(content);
    const first = await research.list({ query: "needle" });
    expect(first.rows).toHaveLength(0);
    expect(first.partial).toBe(true);
    const second = await research.list({ query: "needle", after: first.next! });
    expect(second.rows.map((r) => r.title)).toEqual(["Report 204"]);
    expect(second.next).toBeUndefined();
  }, 240_000);
});
