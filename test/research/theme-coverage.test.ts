import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { renderDossier, type Dossier } from "../../src/research/dossier.js";
import {
  claimCoverage,
  rankForResearch,
  researchState,
  themeCoverage,
} from "../../src/research/theme-coverage.js";
import { ThemeStore } from "../../src/research/theme-store.js";

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-coverage-"));
  artifacts = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cite = {
  id: "who",
  url: "https://who.example/x",
  title: "WHO",
  passage: "Below limits.",
  checkedAt: "2026-11-20",
};
const dossier = (
  claims: Dossier["metadata"]["claims"],
  citations = [cite],
  gaps: string[] = [],
): Dossier => ({
  metadata: {
    schemaVersion: 1,
    themeId: "masts",
    title: "Masts",
    scope: "Phone masts",
    claims,
    citations,
    gaps,
    updatedAt: "2026-11-20",
  },
  body: "Summary.",
});

describe("theme research coverage (#528)", () => {
  it("derives state from evidence, not from existence", () => {
    expect(researchState(undefined)).toBe("unresearched");
    // A dossier with no cited, covered claim is still unresearched.
    expect(researchState(dossier([{ claimId: "a", status: "gap", reason: "none" }], []))).toBe(
      "unresearched",
    );
    expect(
      researchState(
        dossier([
          { claimId: "a", status: "covered", citations: ["who"] },
          { claimId: "b", status: "gap", reason: "no source" },
        ]),
      ),
    ).toBe("partially-researched");
    expect(researchState(dossier([{ claimId: "a", status: "covered", citations: ["who"] }]))).toBe(
      "researched",
    );
  });

  it("reports insufficient claim coverage despite an existing dossier", () => {
    const d = dossier([
      { claimId: "a", status: "covered", citations: ["who"] },
      { claimId: "b", status: "gap", reason: "no source" },
    ]);
    expect(Object.fromEntries(claimCoverage(d, ["a", "b", "c"]))).toEqual({
      a: "covered",
      b: "gap",
      c: "not-in-dossier",
    });
  });

  it("establishes a theme without research, then attaches a dossier under the same ID", async () => {
    await new ThemeStore(artifacts).ensure({
      id: "masts",
      title: "Masts",
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    expect(await themeCoverage(artifacts, "masts")).toMatchObject({ state: "unresearched" });
    expect((await themeCoverage(artifacts, "masts"))?.dossier).toBeUndefined();
    await artifacts.revise(
      "dossier/masts.md",
      renderDossier(dossier([{ claimId: "a", status: "covered", citations: ["who"] }])),
      null,
    );
    const later = await themeCoverage(artifacts, "masts");
    expect(later).toMatchObject({
      theme: { id: "masts", title: "Masts" },
      state: "researched",
      dossier: { covered: 1, gaps: 0, citations: 1 },
    });
    expect(await themeCoverage(artifacts, "unknown")).toBeUndefined();
  });

  it("ranks the least-researched themes first", () => {
    const t = (id: string) => ({
      id,
      title: id,
      schemaVersion: 1 as const,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const ranked = rankForResearch([
      { theme: t("c"), state: "researched" },
      { theme: t("b"), state: "unresearched" },
      { theme: t("a"), state: "partially-researched" },
      { theme: t("a2"), state: "unresearched" },
    ]);
    expect(ranked.map((r) => r.theme.id)).toEqual(["a2", "b", "a", "c"]);
  });
});
