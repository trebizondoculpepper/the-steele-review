import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  librarianPlanPath,
  planLibrarianAssessment,
  proposedThemeId,
  saveLibrarianPlan,
} from "../../src/research/librarian-plan.js";
import type { ThemeMapping } from "../../src/research/theme-mappings.js";

// Synthetic data only.
const mapping = (canonicalThemeId: string): ThemeMapping => ({
  schemaVersion: 1,
  key: "weather modification programmes",
  proposal: "Weather modification programmes",
  canonicalThemeId,
  decidedAt: "2026-02-01T00:00:00.000Z",
  decidedBy: { publicationId: "pub", postId: "old" },
  rationale: "recognised",
});

const base = {
  publicationId: "pub",
  postId: "p1",
  sourceVersion: `sha256:${"a".repeat(64)}`,
  proposals: [{ id: "t1", title: "Weather modification programmes" }],
  claims: [{ claimRecordId: "sha256:" + "b".repeat(64), canonicalThemeId: "geoengineering" }],
  now: () => new Date("2026-02-02T00:00:00.000Z"),
};

describe("librarian assessment and plan (#595)", () => {
  it("reuses a saved mapping and reports a missing dossier as research", () => {
    const plan = planLibrarianAssessment({
      ...base,
      mappings: new Map([["t1", mapping("geoengineering")]]),
      themes: new Set(["geoengineering"]),
      dossiers: new Map(),
    });
    expect(plan.mappings[0]).toMatchObject({ canonicalThemeId: "geoengineering", source: "catalogue" });
    expect(plan.dossiers[0]).toMatchObject({ canonicalThemeId: "geoengineering", action: "create-dossier" });
    expect(plan.claims[0]).toMatchObject({ coverage: "none", action: "research" });
  });

  it("reports partial coverage as targeted enhancement, not a fresh dossier", () => {
    const plan = planLibrarianAssessment({
      ...base,
      mappings: new Map([["t1", mapping("geoengineering")]]),
      themes: new Set(["geoengineering"]),
      dossiers: new Map([
        [
          "geoengineering",
          { coverage: new Map([[base.claims[0]!.claimRecordId, "gap" as const]]) },
        ],
      ]),
    });
    expect(plan.dossiers[0]).toMatchObject({ action: "enhance-existing" });
    expect(plan.dossiers[0]!.gaps.join(" ")).toMatch(/1 claim\(s\) recorded as gaps/);
    expect(plan.claims[0]).toMatchObject({ coverage: "gap", action: "targeted-enhancement" });
  });

  it("reuses a fully covering dossier", () => {
    const plan = planLibrarianAssessment({
      ...base,
      mappings: new Map([["t1", mapping("geoengineering")]]),
      themes: new Set(["geoengineering"]),
      dossiers: new Map([
        ["geoengineering", { coverage: new Map([[base.claims[0]!.claimRecordId, "covered" as const]]) }],
      ]),
    });
    expect(plan.dossiers[0]).toMatchObject({ action: "reuse-existing" });
    expect(plan.claims[0]).toMatchObject({ coverage: "covered", action: "reuse" });
  });

  it("gives an unmapped proposal a deterministic candidate identity, marked new", () => {
    const a = planLibrarianAssessment({ ...base, mappings: new Map(), themes: new Set(), dossiers: new Map() });
    const b = planLibrarianAssessment({ ...base, mappings: new Map(), themes: new Set(), dossiers: new Map() });
    expect(a.mappings[0]).toMatchObject({ source: "new", canonicalThemeId: proposedThemeId("Weather modification programmes") });
    expect(a.mappings[0]!.canonicalThemeId).toBe(b.mappings[0]!.canonicalThemeId);
  });

  it("carries the resolved author and exact inputs, and a changed input makes a new path", () => {
    const plan = planLibrarianAssessment({
      ...base,
      author: { name: "Configured Author", basis: "source-configured" },
      mappings: new Map([["t1", mapping("geoengineering")]]),
      themes: new Set(["geoengineering"]),
      dossiers: new Map(),
    });
    expect(plan.inputs.author).toEqual({ name: "Configured Author", basis: "source-configured" });
    const other = planLibrarianAssessment({
      ...base,
      sourceVersion: `sha256:${"c".repeat(64)}`,
      mappings: new Map([["t1", mapping("geoengineering")]]),
      themes: new Set(["geoengineering"]),
      dossiers: new Map(),
    });
    expect(librarianPlanPath(base, plan)).not.toBe(librarianPlanPath(base, other));
  });

  it("saves write-once so an earlier plan stays readable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-plan-"));
    await mkdir(join(dir, "c"));
    const artifacts = new GitArtifactStore({ repoPath: join(dir, "c"), repository: "content" });
    await artifacts.initialise();
    const plan = planLibrarianAssessment({
      ...base,
      mappings: new Map(),
      themes: new Set(),
      dossiers: new Map(),
    });
    expect(await saveLibrarianPlan(artifacts, plan)).toMatchObject({ reused: false });
    expect(await saveLibrarianPlan(artifacts, plan)).toMatchObject({ reused: true });
    const ref = await artifacts.lookup(librarianPlanPath(base, plan));
    expect(ref).toBeDefined();
    await rm(dir, { recursive: true, force: true });
  });
});
