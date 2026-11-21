import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import { DossierStore } from "../../src/research/dossier.js";
import { ThemeStore, themePath } from "../../src/research/theme-store.js";

let dir: string;
let artifacts: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-themes-"));
  await mkdir(join(dir, "c"));
  artifacts = new GitArtifactStore({ repoPath: join(dir, "c"), repository: "content" });
  await artifacts.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const theme = {
  id: "geoengineering",
  title: "Geoengineering",
  description: "Deliberate modification of the climate.",
  createdAt: "2026-02-01T00:00:00.000Z",
};

describe("canonical theme store (#528)", () => {
  it("records an established theme without creating research", async () => {
    const themes = new ThemeStore(artifacts);
    const saved = await themes.ensure(theme);
    expect(saved.id).toBe("geoengineering");
    expect(await artifacts.lookup(themePath("geoengineering"))).toBeDefined();
    // A theme may have no dossier: establishing one commissions nothing.
    expect(await new DossierStore(artifacts).current("geoengineering")).toBeUndefined();
  });

  it("keeps the first established identity and title", async () => {
    const themes = new ThemeStore(artifacts);
    await themes.ensure(theme);
    const again = await themes.ensure({ ...theme, title: "A later wording" });
    expect(again.title).toBe("Geoengineering");
    expect((await themes.get("geoengineering"))?.title).toBe("Geoengineering");
  });

  it("lists established themes in stable order", async () => {
    const themes = new ThemeStore(artifacts);
    await themes.ensure(theme);
    await themes.ensure({ ...theme, id: "aerial-spraying", title: "Aerial spraying" });
    expect(await themes.list()).toEqual([
      "canonical-themes/aerial-spraying.json",
      "canonical-themes/geoengineering.json",
    ]);
  });

  it("returns the stored theme when a concurrent write lost the race", async () => {
    const themes = new ThemeStore(artifacts);
    const first = await themes.ensure(theme);
    // Simulate the other assessment winning between read and write.
    const second = await themes.ensure({ ...theme, createdAt: "2026-03-01T00:00:00.000Z" });
    expect(second).toEqual(first);
  });

  it("does not list per-post theme extraction artifacts", async () => {
    const themes = new ThemeStore(artifacts);
    await themes.ensure(theme);
    // Extraction results share a similar shape under themes/; the canonical
    // listing must ignore them.
    await artifacts.write("themes/pub/p1/abc.json", "{}\n");
    expect(await themes.list()).toEqual(["canonical-themes/geoengineering.json"]);
  });

  it("returns nothing for an unknown theme", async () => {
    expect(await new ThemeStore(artifacts).get("unknown-theme")).toBeUndefined();
  });
});
