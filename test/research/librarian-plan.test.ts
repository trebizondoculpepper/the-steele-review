import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import {
  librarianPlanPath,
  planLibrarianAssessment,
  proposedThemeId,
  readLibrarianPlan,
  saveLibrarianPlan,
} from "../../src/research/librarian-plan.js";
import type { ThemeMapping } from "../../src/research/theme-mappings.js";

// Synthetic data only.
/** An exact pinned artifact version; `n` varies the commit and content. */
const pin = (path: string, n = "a") => ({
  repository: "content",
  commit: n.repeat(40),
  path,
  sha256: n.repeat(64),
});
const decision = (canonicalThemeId: string): ThemeMapping => ({
  schemaVersion: 1,
  key: "weather modification programmes",
  proposal: "Weather modification programmes",
  canonicalThemeId,
  decidedAt: "2026-02-01T00:00:00.000Z",
  decidedBy: { publicationId: "pub", postId: "old" },
  rationale: "recognised",
});
const mapping = (canonicalThemeId: string, n = "a") => ({
  mapping: decision(canonicalThemeId),
  ref: pin(`librarian/theme-mappings/${canonicalThemeId}.json`, n),
});

const base = {
  publicationId: "pub",
  postId: "p1",
  source: pin("sources/pub/p1/post.json"),
  sourceContext: pin("config/sources/pub.json"),
  configuration: pin("config/librarian.json"),
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
    expect(plan.mappings[0]).toMatchObject({
      canonicalThemeId: "geoengineering",
      source: "catalogue",
    });
    expect(plan.dossiers[0]).toMatchObject({
      canonicalThemeId: "geoengineering",
      action: "create-dossier",
    });
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
        [
          "geoengineering",
          { coverage: new Map([[base.claims[0]!.claimRecordId, "covered" as const]]) },
        ],
      ]),
    });
    expect(plan.dossiers[0]).toMatchObject({ action: "reuse-existing" });
    expect(plan.claims[0]).toMatchObject({ coverage: "covered", action: "reuse" });
  });

  it("gives an unmapped proposal a deterministic candidate identity, marked new", () => {
    const a = planLibrarianAssessment({
      ...base,
      mappings: new Map(),
      themes: new Set(),
      dossiers: new Map(),
    });
    const b = planLibrarianAssessment({
      ...base,
      mappings: new Map(),
      themes: new Set(),
      dossiers: new Map(),
    });
    expect(a.mappings[0]).toMatchObject({
      source: "new",
      canonicalThemeId: proposedThemeId("Weather modification programmes"),
    });
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
      source: pin("sources/pub/p1/post.json", "c"),
      mappings: new Map([["t1", mapping("geoengineering")]]),
      themes: new Set(["geoengineering"]),
      dossiers: new Map(),
    });
    expect(librarianPlanPath(base, plan)).not.toBe(librarianPlanPath(base, other));
  });

  it("counts a claim missing from an existing dossier as a gap", () => {
    const plan = planLibrarianAssessment({
      ...base,
      mappings: new Map([["t1", mapping("geoengineering")]]),
      themes: new Set(["geoengineering"]),
      // The dossier exists but records nothing for this claim.
      dossiers: new Map([["geoengineering", { coverage: new Map() }]]),
    });
    expect(plan.dossiers[0]).toMatchObject({ action: "enhance-existing" });
    expect(plan.claims[0]).toMatchObject({ coverage: "gap", action: "targeted-enhancement" });
  });

  it("separates same-titled proposals by description", () => {
    const planet = planLibrarianAssessment({
      ...base,
      proposals: [{ id: "a", title: "Mercury", description: "the planet" }],
      claims: [],
      mappings: new Map(),
      themes: new Set(),
      dossiers: new Map(),
    });
    const metal = planLibrarianAssessment({
      ...base,
      proposals: [{ id: "b", title: "Mercury", description: "the toxic metal" }],
      claims: [],
      mappings: new Map(),
      themes: new Set(),
      dossiers: new Map(),
    });
    expect(planet.mappings[0]!.canonicalThemeId).not.toBe(metal.mappings[0]!.canonicalThemeId);
  });

  it("changes the plan path when a dossier assessment or author basis changes", () => {
    const make = (
      dossiers: Map<string, { coverage: Map<string, "covered" | "gap"> }>,
      basis: "post-byline" | "source-configured",
    ) =>
      planLibrarianAssessment({
        ...base,
        author: { name: "A", basis },
        mappings: new Map([["t1", mapping("geoengineering")]]),
        themes: new Set(["geoengineering"]),
        dossiers,
      });
    const empty = make(new Map(), "post-byline");
    const covered = make(
      new Map([
        [
          "geoengineering",
          { coverage: new Map([[base.claims[0]!.claimRecordId, "covered" as const]]) },
        ],
      ]),
      "post-byline",
    );
    const otherBasis = make(new Map(), "source-configured");
    expect(librarianPlanPath(base, empty)).not.toBe(librarianPlanPath(base, covered));
    expect(librarianPlanPath(base, empty)).not.toBe(librarianPlanPath(base, otherBasis));
  });

  it("bounds a long catalogue key in the rationale instead of failing", () => {
    const long = {
      ...mapping("geoengineering"),
      mapping: { ...decision("geoengineering"), key: "k".repeat(2400) },
    };
    const plan = planLibrarianAssessment({
      ...base,
      proposals: [
        { id: "t1", title: "Weather modification programmes", description: "x".repeat(2000) },
      ],
      mappings: new Map([["t1", long]]),
      themes: new Set(["geoengineering"]),
      dossiers: new Map(),
    });
    expect(plan.mappings[0]!.rationale.length).toBeLessThanOrEqual(1000);
    expect(plan.mappings[0]!.rationale).toContain("reused saved catalogue decision");
  });

  it("changes the path when a claim moves between themes", () => {
    const claimA = "sha256:" + "b".repeat(64);
    const claimB = "sha256:" + "c".repeat(64);
    const make = (claims: Array<{ claimRecordId: string; canonicalThemeId: string }>) =>
      planLibrarianAssessment({
        ...base,
        proposals: [
          { id: "t1", title: "Weather modification programmes" },
          { id: "t2", title: "Aerial spraying" },
        ],
        claims,
        mappings: new Map([
          ["t1", mapping("geoengineering")],
          ["t2", mapping("aerial-spraying")],
        ]),
        themes: new Set(["geoengineering", "aerial-spraying"]),
        dossiers: new Map(),
      });
    const before = make([
      { claimRecordId: claimA, canonicalThemeId: "geoengineering" },
      { claimRecordId: claimB, canonicalThemeId: "aerial-spraying" },
    ]);
    const after = make([
      { claimRecordId: claimA, canonicalThemeId: "aerial-spraying" },
      { claimRecordId: claimB, canonicalThemeId: "geoengineering" },
    ]);
    expect(librarianPlanPath(base, before)).not.toBe(librarianPlanPath(base, after));
  });

  it("counts gaps only from this article's claims", () => {
    const mine = base.claims[0]!.claimRecordId;
    const plan = planLibrarianAssessment({
      ...base,
      mappings: new Map([["t1", mapping("geoengineering")]]),
      themes: new Set(["geoengineering"]),
      dossiers: new Map([
        [
          "geoengineering",
          {
            coverage: new Map<string, "covered" | "gap">([
              [mine, "covered"],
              [`sha256:${"d".repeat(64)}`, "gap"], // historical, unrelated claim
            ]),
          },
        ],
      ]),
    });
    expect(plan.dossiers[0]).toMatchObject({ action: "reuse-existing" });
  });

  it("does not borrow coverage for a claim from an unresolved theme", () => {
    const plan = planLibrarianAssessment({
      ...base,
      claims: [
        { claimRecordId: base.claims[0]!.claimRecordId, canonicalThemeId: "some-other-theme" },
      ],
      mappings: new Map([["t1", mapping("geoengineering")]]),
      themes: new Set(["geoengineering", "some-other-theme"]),
      dossiers: new Map([
        [
          "some-other-theme",
          { coverage: new Map([[base.claims[0]!.claimRecordId, "covered" as const]]) },
        ],
      ]),
    });
    expect(plan.claims[0]).toMatchObject({ coverage: "none", action: "research" });
  });

  it("pins the assessed dossier revision in the plan and its identity", () => {
    const make = (ref: ReturnType<typeof pin>) =>
      planLibrarianAssessment({
        ...base,
        mappings: new Map([["t1", mapping("geoengineering")]]),
        themes: new Set(["geoengineering"]),
        dossiers: new Map([
          [
            "geoengineering",
            { coverage: new Map([[base.claims[0]!.claimRecordId, "covered" as const]]), ref },
          ],
        ]),
      });
    const first = make(pin("dossiers/geoengineering.json"));
    const second = make(pin("dossiers/geoengineering.json", "b"));
    expect(first.dossiers[0]!.dossierRef).toEqual(pin("dossiers/geoengineering.json"));
    expect(librarianPlanPath(base, first)).not.toBe(librarianPlanPath(base, second));
  });

  it("records the extraction artifacts and makes them part of the identity", () => {
    const make = (claimResult: ReturnType<typeof pin>) =>
      planLibrarianAssessment({
        ...base,
        themeResult: pin("themes/pub/p1/v1.json"),
        claimResult,
        mappings: new Map([["t1", mapping("geoengineering")]]),
        themes: new Set(["geoengineering"]),
        dossiers: new Map(),
      });
    const first = make(pin("claim-extractions/pub/p1/v1.json"));
    const second = make(pin("claim-extractions/pub/p1/v2.json", "b"));
    expect(first.inputs).toMatchObject({
      themeResult: pin("themes/pub/p1/v1.json"),
      claimResult: pin("claim-extractions/pub/p1/v1.json"),
    });
    // Same source text, different extraction: a different assessment.
    expect(librarianPlanPath(base, first)).not.toBe(librarianPlanPath(base, second));
    // The original proposal and claim payloads are preserved.
    expect(first.mappings[0]!.proposalTitle).toBe("Weather modification programmes");
  });

  it("saves write-once and returns the authoritative saved version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-plan-"));
    await mkdir(join(dir, "c"));
    const artifacts = new GitArtifactStore({ repoPath: join(dir, "c"), repository: "content" });
    await artifacts.initialise();
    const make = (at: string) =>
      planLibrarianAssessment({
        ...base,
        mappings: new Map(),
        themes: new Set(),
        dossiers: new Map(),
        now: () => new Date(at),
      });
    const first = await saveLibrarianPlan(artifacts, make("2026-02-02T00:00:00.000Z"));
    expect(first).toMatchObject({ reused: false });
    expect(first.ref).toEqual(await artifacts.lookup(first.path));
    // A later identical assessment reuses the stored plan and returns its
    // exact version, not the caller's copy with a newer timestamp.
    const again = await saveLibrarianPlan(artifacts, make("2026-03-03T00:00:00.000Z"));
    expect(again).toMatchObject({ reused: true, path: first.path });
    expect(again.ref).toEqual(first.ref);
    expect(again.plan.createdAt).toBe("2026-02-02T00:00:00.000Z");
    expect(await readLibrarianPlan(artifacts, again.ref)).toEqual(first.plan);
    await rm(dir, { recursive: true, force: true });
  });

  it("makes a context-only or mapping-metadata-only change a new plan", () => {
    const make = (over: Partial<Parameters<typeof planLibrarianAssessment>[0]>) =>
      planLibrarianAssessment({
        ...base,
        mappings: new Map([["t1", mapping("geoengineering")]]),
        themes: new Set(["geoengineering"]),
        dossiers: new Map(),
        ...over,
      });
    const original = make({});
    const path = librarianPlanPath(base, original);
    // Only the configured author context changed: same source, same decisions.
    const context = make({ sourceContext: pin("config/sources/pub.json", "d") });
    expect(context.mappings).toEqual(original.mappings);
    expect(librarianPlanPath(base, context)).not.toBe(path);
    // No context configured is recorded as such, and differs from a context.
    const none = make({ sourceContext: null });
    expect(none.inputs.sourceContext).toBeNull();
    expect(librarianPlanPath(base, none)).not.toBe(path);
    // Only the librarian configuration changed.
    expect(
      librarianPlanPath(base, make({ configuration: pin("config/librarian.json", "e") })),
    ).not.toBe(path);
    // The mapping's saved metadata changed (same canonical theme).
    const revised = make({ mappings: new Map([["t1", mapping("geoengineering", "f")]]) });
    expect(revised.mappings[0]!.canonicalThemeId).toBe("geoengineering");
    expect(revised.mappings[0]!.mappingRef).toEqual(
      pin("librarian/theme-mappings/geoengineering.json", "f"),
    );
    expect(librarianPlanPath(base, revised)).not.toBe(path);
  });

  it("refuses free-text or malformed references", () => {
    const run = (over: object) => () =>
      planLibrarianAssessment({
        ...base,
        mappings: new Map(),
        themes: new Set(),
        dossiers: new Map(),
        ...over,
      } as Parameters<typeof planLibrarianAssessment>[0]);
    expect(run({ source: "content@aaaa:sources/x.json" })).toThrow();
    expect(run({ configuration: { ...pin("config/librarian.json"), sha256: "nothex" } })).toThrow();
    expect(run({ themeResult: "content@aaaa:themes/pub/p1/v1.json" })).toThrow();
    expect(run({ sourceContext: undefined })).toThrow();
  });

  it("still reads a legacy schema-1 plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "steele-plan-"));
    await mkdir(join(dir, "c"));
    const artifacts = new GitArtifactStore({ repoPath: join(dir, "c"), repository: "content" });
    await artifacts.initialise();
    const legacy = {
      schemaVersion: 1,
      inputs: {
        publicationId: "pub",
        postId: "p1",
        sourceVersion: `sha256:${"a".repeat(64)}`,
        themeResult: "content@aaaa:themes/pub/p1/v1.json",
      },
      mappings: [
        {
          proposalId: "t1",
          canonicalThemeId: "geoengineering",
          source: "catalogue",
          rationale: "r",
        },
      ],
      dossiers: [
        {
          canonicalThemeId: "geoengineering",
          action: "reuse-existing",
          dossierRef: "content@aaaa:dossiers/geoengineering.json",
          rationale: "r",
          gaps: [],
        },
      ],
      claims: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const ref = await artifacts.write("librarian/plans/pub/p1/legacy.json", JSON.stringify(legacy));
    const read = await readLibrarianPlan(artifacts, ref);
    expect(read.schemaVersion).toBe(1);
    expect(read.inputs).toMatchObject({ sourceVersion: legacy.inputs.sourceVersion });
    await rm(dir, { recursive: true, force: true });
  });
});
