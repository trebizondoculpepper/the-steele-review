import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { ThemeMappingCatalogue, themeMappingPath } from "../../src/research/theme-mappings.js";
import { ArtifactStoreError } from "../../src/controllers/artifact-store.js";

// Synthetic catalogue only.
let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-mappings-"));
  await mkdir(join(dir, "c"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "c"), repository: "content" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const decided = {
  proposal: "Weather modification programmes",
  canonicalThemeId: "geoengineering",
  decidedAt: "2026-02-01T00:00:00.000Z",
  decidedBy: { publicationId: "pub", postId: "p1" },
  rationale: "Recognised as the broader canonical topic.",
};

describe("theme mapping catalogue (#518)", () => {
  it("reuses one decision across posts regardless of case and punctuation", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    await catalogue.record(decided);
    const found = await catalogue.lookup({ proposal: "  weather   MODIFICATION programmes! " });
    expect(found).toMatchObject({ canonicalThemeId: "geoengineering", proposal: decided.proposal });
  });

  it("returns nothing when no decision was ever made", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    expect(await catalogue.lookup({ proposal: "unfamiliar topic" })).toBeUndefined();
  });

  it("prefers a scoped decision over the global one", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    await catalogue.record(decided);
    await catalogue.record({
      ...decided,
      scope: "synthetic-newsletter",
      canonicalThemeId: "narrow-topic",
    });
    expect(
      (await catalogue.lookup({ proposal: decided.proposal, scope: "synthetic-newsletter" }))
        ?.canonicalThemeId,
    ).toBe("narrow-topic");
    expect((await catalogue.lookup({ proposal: decided.proposal }))?.canonicalThemeId).toBe(
      "geoengineering",
    );
    expect(
      (await catalogue.lookup({ proposal: decided.proposal, scope: "another-source" }))
        ?.canonicalThemeId,
    ).toBe("geoengineering");
  });

  it("keeps the first decision when the same key is recorded again", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    await catalogue.record(decided);
    const again = await catalogue.record({ ...decided, canonicalThemeId: "a-different-topic" });
    expect(again.canonicalThemeId).toBe("geoengineering");
    expect((await catalogue.lookup({ proposal: decided.proposal }))?.canonicalThemeId).toBe(
      "geoengineering",
    );
  });

  it("separates same-titled proposals that mean different things", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    await catalogue.record({ ...decided, proposal: "Mercury", description: "the planet" });
    expect(
      (await catalogue.lookup({ proposal: "Mercury", description: "the planet" }))
        ?.canonicalThemeId,
    ).toBe("geoengineering");
    // A different meaning must not inherit the planet's mapping.
    expect(
      await catalogue.lookup({ proposal: "Mercury", description: "the toxic metal" }),
    ).toBeUndefined();
  });

  it("handles a non-ASCII proposal without an invalid artifact path", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    const saved = await catalogue.record({ ...decided, proposal: "El Niño anomalies" });
    expect(saved.key).toBe("el niño anomalies");
    // Case and punctuation fold; a different spelling is a different key.
    expect((await catalogue.lookup({ proposal: "EL NIÑO anomalies!" }))?.canonicalThemeId).toBe(
      "geoengineering",
    );
    expect(await catalogue.lookup({ proposal: "el nino anomalies" })).toBeUndefined();
    const path = themeMappingPath(saved);
    expect(path).toMatch(/^librarian\/theme-mappings\/global\/[A-Za-z0-9-]+\.json$/);
  });

  it("returns the stored winner when a concurrent write lost the race", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    const first = await catalogue.record(decided);
    // Simulate the other assessment winning between lookup and write by
    // re-recording a differing payload for the same key.
    const second = await catalogue.record({
      ...decided,
      canonicalThemeId: "another-topic",
      decidedBy: { publicationId: "pub", postId: "p2" },
    });
    expect(second).toEqual(first);
    expect((await catalogue.lookup({ proposal: decided.proposal }))?.canonicalThemeId).toBe(
      "geoengineering",
    );
  });

  it("stores the decision as a versioned corpus artifact", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    const saved = await catalogue.record(decided);
    const path = themeMappingPath(saved);
    expect(path).toMatch(
      /^librarian\/theme-mappings\/global\/weather-modification-programmes-[0-9a-f]{12}\.json$/,
    );
    expect(await artifacts.lookup(path)).toBeDefined();
  });
});

describe("mapping corrections as file revisions (#518)", () => {
  it("corrects a mapping in place while a pinned version keeps its original bytes", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    const first = await catalogue.recordPinned(decided);
    const corrected = await catalogue.correct({
      expected: first.ref,
      change: { canonicalThemeId: "weather-control" },
      reason: "split: weather modification is its own canonical theme",
      correctedAt: "2026-03-01T00:00:00.000Z",
    });
    // Current lookup sees the correction...
    expect((await catalogue.lookup({ proposal: decided.proposal }))?.canonicalThemeId).toBe(
      "weather-control",
    );
    expect(corrected.ref.path).toBe(first.ref.path);
    // ...while the earlier pin still reads exactly what that brief used.
    expect((await catalogue.pinned(first.ref)).canonicalThemeId).toBe("geoengineering");
    expect(corrected.mapping).toMatchObject({
      method: "manual",
      correction: { reason: expect.stringMatching(/split/) },
    });
    // No journal: only the mapping file exists under the catalogue.
    expect(await artifacts.list("librarian/theme-mappings", 50)).toEqual([first.ref.path]);
  });

  it("refuses a correction made against a stale version", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    const first = await catalogue.recordPinned(decided);
    await catalogue.correct({
      expected: first.ref,
      change: { canonicalThemeId: "weather-control" },
      reason: "first correction",
      correctedAt: "2026-03-01T00:00:00.000Z",
    });
    await expect(
      catalogue.correct({
        expected: first.ref,
        change: { canonicalThemeId: "climate" },
        reason: "a concurrent, different correction",
        correctedAt: "2026-03-02T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "stale-revision" });
    expect((await catalogue.lookup({ proposal: decided.proposal }))?.canonicalThemeId).toBe(
      "weather-control",
    );
  });

  it("leaves a changed meaning unresolved instead of guessing", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    const first = await catalogue.recordPinned(decided);
    await catalogue.correct({
      expected: first.ref,
      change: { unresolved: true },
      reason: "meaning changed; needs a fresh decision",
      correctedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(await catalogue.lookup({ proposal: decided.proposal })).toBeUndefined();
    // A fresh accepted decision resolves it, as a revision of the same file.
    const resolved = await catalogue.recordPinned({
      ...decided,
      canonicalThemeId: "weather-control",
    });
    expect(resolved.mapping.status).toBeUndefined();
    expect(resolved.ref.path).toBe(first.ref.path);
    expect((await catalogue.lookup({ proposal: decided.proposal }))?.canonicalThemeId).toBe(
      "weather-control",
    );
    // The earlier versions stay readable by their pins.
    expect((await catalogue.pinned(first.ref)).canonicalThemeId).toBe("geoengineering");
  });

  it("records decision method and source provenance", async () => {
    const catalogue = new ThemeMappingCatalogue(artifacts);
    const source = {
      themeResult: {
        repository: "content",
        commit: "c".repeat(40),
        path: "theme-proposals/p/x/r.json",
        hash: `sha256:${"d".repeat(64)}`,
      },
      proposalId: "theme-1",
    };
    const saved = await catalogue.recordPinned({ ...decided, method: "embedding", source });
    expect(saved.mapping).toMatchObject({ method: "embedding", source });
  });
});
