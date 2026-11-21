import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { ThemeMappingCatalogue, themeMappingPath } from "../../src/research/theme-mappings.js";

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
      (await catalogue.lookup({ proposal: "Mercury", description: "the planet" }))?.canonicalThemeId,
    ).toBe("geoengineering");
    // A different meaning must not inherit the planet's mapping.
    expect(await catalogue.lookup({ proposal: "Mercury", description: "the toxic metal" })).toBeUndefined();
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
    expect(path).toMatch(/^librarian\/theme-mappings\/global\/weather-modification-programmes-[0-9a-f]{12}\.json$/);
    expect(await artifacts.lookup(path)).toBeDefined();
  });
});
