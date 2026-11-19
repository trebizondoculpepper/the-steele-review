import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import {
  ThemeCatalogueStore,
  detectThemes,
  selectCandidates,
  themeSlug,
} from "../../src/analysis/theme-catalogue.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";

const TEXT =
  "They are spraying the skies again. Weather modification tools have been around for a long time. Also the bins were late.";
const source = {
  text: TEXT,
  sourceVersion: sourceVersionFor(TEXT),
  artifact: {
    repository: "archive",
    commit: "a".repeat(40),
    path: "substack/pub/post/collected.json",
    hash: `sha256:${"b".repeat(64)}`,
  },
};
const post = { publicationId: "pub", postId: "post" };

let dir: string;
let content: GitArtifactStore;
let catalogue: ThemeCatalogueStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-catalogue-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
  catalogue = new ThemeCatalogueStore(content);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function model(...responses: string[]): ExtractionModelProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    modelVersion: "fake/model",
    calls,
    async complete(req) {
      calls.push(req.user);
      const next = responses.shift();
      if (next === undefined) throw new Error("no response");
      return next;
    },
  };
}

const seed = async () =>
  catalogue.register([
    {
      name: "Geoengineering",
      definition: "Claims that weather or climate is deliberately modified at scale.",
      aliases: ["weather modification"],
      origin: "seed",
    },
  ]);

describe("theme catalogue", () => {
  it("reuses identities by exact name or alias and never duplicates under concurrency", async () => {
    const { ids } = await seed();
    expect(ids).toEqual(["geoengineering"]);
    const same = await catalogue.register([
      {
        name: "Weather Modification",
        definition: "Claims that weather or climate is deliberately modified at scale.",
        aliases: [],
        origin: "detected",
      },
    ]);
    expect(same.ids).toEqual(["geoengineering"]);
    // Same name, different scope: separate identity, linked as a possible match, stable on rerun.
    const other1 = await catalogue.register([
      {
        name: "Weather Modification",
        definition: "Cloud seeding for agriculture.",
        aliases: [],
        origin: "detected",
      },
    ]);
    const other2 = await catalogue.register([
      {
        name: "Weather Modification",
        definition: "Cloud seeding for agriculture.",
        aliases: [],
        origin: "detected",
      },
    ]);
    expect(other1.ids[0]).not.toBe("geoengineering");
    expect(other2.ids).toEqual(other1.ids);
    const linked = (await catalogue.load()).catalogue.themes.find((t) => t.id === other1.ids[0]);
    expect(linked?.possibleMatchOf).toBe("geoengineering");

    const other = new ThemeCatalogueStore(content);
    const [a, b] = await Promise.all([
      catalogue.register([
        { name: "Smart meters", definition: "d", aliases: [], origin: "detected" },
      ]),
      other.register([{ name: "Smart meters", definition: "d", aliases: [], origin: "detected" }]),
    ]);
    expect(a.ids).toEqual(b.ids);
    const ids2 = (await catalogue.load()).catalogue.themes.map((t) => t.id);
    expect(ids2).toEqual(["geoengineering", other1.ids[0], "smart-meters"]);
    void ids2;
    expect(themeSlug("Chemtrails & 5G!")).toBe("chemtrails-and-5g");
    expect(themeSlug("Dépopulation")).toBe("depopulation");
    const long = await catalogue.register([
      { name: "one two three four five six seven", definition: "a", aliases: [], origin: "seed" },
      { name: "one two three four five six eight", definition: "b", aliases: [], origin: "seed" },
    ]);
    expect(long.ids[0]).not.toBe(long.ids[1]);
    expect(themeSlug("人口削減")).toMatch(/^theme-[0-9a-f]{12}$/);

    // An uncertain proposal with a colliding name stays separate, idempotently.
    const unsure = {
      name: "Geoengineering",
      definition: "maybe",
      aliases: [],
      origin: "detected" as const,
      possibleMatchOf: "geoengineering",
    };
    const u1 = await catalogue.register([unsure]);
    const u2 = await catalogue.register([unsure]);
    expect(u1.ids[0]).not.toBe("geoengineering");
    expect(u2.ids).toEqual(u1.ids);
  });
});

describe("selectCandidates", () => {
  it("keeps relevant themes when the catalogue exceeds the limit", () => {
    const filler = Array.from({ length: 300 }, (_, i) => ({
      id: `filler-${i}`,
      name: `Filler ${i}`,
      definition: "Unrelated topic.",
      aliases: [],
      origin: "seed" as const,
    }));
    const late = {
      id: "smart-meters",
      name: "Smart meters",
      definition: "Claims about smart meters harming health.",
      aliases: [],
      origin: "detected" as const,
    };
    const chosen = selectCandidates([...filler, late], "Remove your smart meters now", 200);
    expect(chosen).toHaveLength(200);
    expect(chosen[0].id).toBe("smart-meters");
  });
});

describe("detectThemes", () => {
  it("returns existing themes with evidence and registers a justified new theme", async () => {
    await seed();
    const m = model(
      JSON.stringify({
        existing: [
          {
            id: "geoengineering",
            confidence: "high",
            passages: [{ passage: "Weather modification tools have been around for a long time." }],
          },
        ],
        proposed: [
          {
            name: "Aerial spraying",
            definition: "Claims that substances are sprayed from aircraft.",
            confidence: "medium",
            possibleMatchOf: "geoengineering",
            passages: [{ passage: "They are spraying the skies again." }],
          },
        ],
      }),
    );
    const out = await detectThemes({ provider: m, catalogue, artifacts: content, post, source });
    if (out.status !== "detected") throw new Error(out.status);
    expect(out.themeIds).toEqual(["geoengineering", "aerial-spraying"]);
    expect(out.detection.existing[0].evidence[0].start).toBe(TEXT.indexOf("Weather"));
    // Uncertain match stays a separate identity, recording the candidate.
    const spraying = (await catalogue.load()).catalogue.themes.find(
      (t) => t.id === "aerial-spraying",
    );
    expect(spraying?.possibleMatchOf).toBe("geoengineering");
    // The catalogue was in the prompt, the source fenced.
    expect(m.calls[0]).toContain('"id":"geoengineering"');

    // Rerun: stored detection reused, no model call, no duplicate identities.
    const rerun = await detectThemes({
      provider: model(),
      catalogue,
      artifacts: content,
      post,
      source,
    });
    if (rerun.status !== "detected") throw new Error(rerun.status);
    expect(rerun.reused).toBe(true);
    expect(rerun.themeIds).toEqual(out.themeIds);
    expect((await catalogue.load()).catalogue.themes).toHaveLength(2);
  });

  it("keeps two same-named proposals with different scopes as separate themes", async () => {
    const proposal = (definition: string, passage: string) => ({
      name: "Spraying",
      definition,
      confidence: "low",
      passages: [{ passage }],
    });
    const out = await detectThemes({
      provider: model(
        JSON.stringify({
          existing: [],
          proposed: [
            proposal("Aircraft spraying claims.", "They are spraying the skies again."),
            proposal("Pesticide use on crops.", "Also the bins were late."),
            proposal("Aircraft spraying claims.", "They are spraying the skies again."),
          ],
        }),
      ),
      catalogue,
      artifacts: content,
      post: { ...post, postId: "two-sprayings" },
      source,
    });
    if (out.status !== "detected") throw new Error(out.status);
    expect(out.themeIds).toHaveLength(2);
    expect(out.detection.rejected.map((r) => r.reason)).toEqual(["duplicate-proposal"]);
  });

  it("accepts no themes and rejects unknown IDs and ungrounded passages", async () => {
    await seed();
    const none = await detectThemes({
      provider: model('{"existing":[],"proposed":[]}'),
      catalogue,
      artifacts: content,
      post: { ...post, postId: "unrelated" },
      source,
    });
    expect(none.status === "detected" && none.themeIds).toEqual([]);

    const bad = await detectThemes({
      provider: model(
        JSON.stringify({
          existing: [
            { id: "invented", confidence: "low", passages: [{ passage: "bins" }] },
            { id: "geoengineering", confidence: "low", passages: [{ passage: "not in text" }] },
          ],
          proposed: [
            {
              name: "Bins",
              definition: "d",
              confidence: "low",
              possibleMatchOf: "nonexistent",
              passages: [{ passage: "Also the bins were late." }],
            },
          ],
        }),
      ),
      catalogue,
      artifacts: content,
      post: { ...post, postId: "bad" },
      source,
    });
    if (bad.status !== "detected") throw new Error(bad.status);
    expect(bad.themeIds).toEqual([]);
    expect(bad.detection.rejected.map((r) => r.reason)).toEqual([
      "unknown-id",
      "passage-absent",
      "unknown-possible-match",
    ]);
  });

  it("reports malformed output after bounded attempts and stores nothing", async () => {
    const out = await detectThemes({
      provider: model("not json", '```json\n{"themes":[]}\n```'),
      catalogue,
      artifacts: content,
      post,
      source,
    });
    expect(out).toEqual({ status: "failed", reason: "malformed-output", attempts: 2 });
    expect(await content.list("theme-detections", 10)).toEqual([]);
  });
});
