import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import { ThemeCatalogueStore } from "../../src/analysis/theme-catalogue.js";
import {
  DEFAULT_THEME_PROPOSAL_PROMPT,
  IncompatibleThemeResultError,
  parseThemeProposalResult,
  proposalId,
  proposeThemes,
  themeProposalPath,
} from "../../src/analysis/theme-proposals.js";
import { saveSourceContext, sourceContextFor } from "../../src/content/source-context.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";

const TEXT = "They are spraying the skies again. 5G masts are weapons.";
const post = { publicationId: "pub", postId: "post" };
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

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-proposals-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function model(
  modelVersion: string,
  ...responses: string[]
): ExtractionModelProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    modelVersion,
    calls,
    async complete(req) {
      calls.push(req.user);
      const next = responses.shift();
      if (next === undefined) throw new Error("none");
      return next;
    },
  };
}

describe("broad-topic prompt (#168)", () => {
  it("asks for established researchable topics without treating notability as truth", () => {
    const text = DEFAULT_THEME_PROPOSAL_PROMPT.instructions;
    // The version carries the prompt file's content hash (#421).
    expect(DEFAULT_THEME_PROPOSAL_PROMPT.version).toMatch(
      /^analysis-theme-proposals-v2-sha256:[0-9a-f]{64}$/,
    );
    expect(text).toMatch(/encyclopedia/);
    expect(text).toMatch(/not evidence that anything is true/);
    expect(text).toMatch(/Do not invent or cite article URLs/);
    expect(text).toMatch(/unusual individual assertion/);
  });

  it("does not reuse a result saved under the previous prompt version", async () => {
    const v1 = { version: "theme-proposals-v1", instructions: "old" };
    await proposeThemes({
      provider: model("fake/a", '{"themes":[{"title":"Old"}]}'),
      prompt: v1,
      artifacts: content,
      post,
      source,
    });
    // Established topic plus an unusual individual assertion: one broad theme.
    const fresh = await proposeThemes({
      provider: model("fake/a", '{"themes":[{"title":"Chemtrail conspiracy theory"}]}'),
      artifacts: content,
      post,
      source,
    });
    if (fresh.status !== "proposed") throw new Error(fresh.status);
    expect(fresh.reused).toBe(false);
    expect(fresh.result.proposals.map((p) => p.title)).toEqual(["Chemtrail conspiracy theory"]);
  });
});

describe("proposeThemes", () => {
  it("pins provenance in model input and invalidates reuse when metadata changes", async () => {
    const captured = {
      item: { ...post, url: "https://source.example/p/post", title: "Source title" },
      ingestionReason: "backfill" as const,
      text: TEXT,
      complete: true,
      supplied: {},
      provenance: {
        sourceUrl: "https://source.example/p/post",
        acquiredAt: "2026-01-01T00:00:00Z",
        method: "article-html",
        postType: "newsletter",
      },
    };
    const archive = { ...source.artifact, sha256: source.artifact.hash.slice(7) };
    const first = await saveSourceContext(content, sourceContextFor(captured, archive));
    const second = await saveSourceContext(
      content,
      sourceContextFor(captured, archive, {
        status: "resolved",
        author: "Configured Author",
        basis: "source-configured",
        sourceMetadataVersion: "registry-v2",
      }),
    );
    const provider = model(
      "fake/context",
      '{"themes":[{"title":"Geoengineering"}]}',
      '{"themes":[{"title":"Geoengineering"}]}',
    );
    const a = await proposeThemes({
      provider,
      artifacts: content,
      post,
      source,
      sourceContext: first,
    });
    const b = await proposeThemes({
      provider,
      artifacts: content,
      post,
      source,
      sourceContext: second,
    });
    const again = await proposeThemes({
      provider,
      artifacts: content,
      post,
      source,
      sourceContext: second,
    });
    expect(a.status).toBe("proposed");
    if (a.status !== "proposed") throw new Error(a.status);
    expect(
      await content.lookup(
        themeProposalPath(
          post,
          source.sourceVersion,
          provider.modelVersion,
          DEFAULT_THEME_PROPOSAL_PROMPT.version,
          first,
        ),
      ),
    ).toEqual(a.ref);
    expect(b.status).toBe("proposed");
    expect(again).toMatchObject({ status: "proposed", reused: true });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]).toContain('"originalMedium":"written"');
    expect(provider.calls[1]).toContain('"author":"Configured Author"');
    const wrong = await saveSourceContext(content, {
      ...sourceContextFor(captured, archive),
      source: { ...sourceContextFor(captured, archive).source, postId: "other" },
    });
    expect(
      await proposeThemes({ provider, artifacts: content, post, source, sourceContext: wrong }),
    ).toMatchObject({ status: "failed", reason: "source-context-mismatch" });
    expect(provider.calls).toHaveLength(2);
  });

  it("accepts title-only and described proposals with no quotation, ignoring legacy quote fields", async () => {
    const out = await proposeThemes({
      provider: model(
        "fake/a",
        JSON.stringify({
          themes: [
            { title: "Geoengineering" },
            {
              title: "5G health fears",
              description: "Claims that 5G networks harm people.",
              passages: [{ passage: "invented" }],
            },
          ],
        }),
      ),
      artifacts: content,
      post,
      source,
    });
    if (out.status !== "proposed") throw new Error(out.status);
    expect(out.result.proposals).toEqual([
      { id: proposalId(post, source.sourceVersion, "Geoengineering"), title: "Geoengineering" },
      {
        id: proposalId(post, source.sourceVersion, "5G health fears"),
        title: "5G health fears",
        description: "Claims that 5G networks harm people.",
      },
    ]);
    expect(JSON.stringify(out.result)).not.toContain("invented");
    expect(out.result.extraction).toMatchObject({
      schemaVersion: 1,
      modelVersion: "fake/a",
      promptVersion: DEFAULT_THEME_PROPOSAL_PROMPT.version,
    });
  });

  it("allows no themes and reports duplicate titles deterministically", async () => {
    const none = await proposeThemes({
      provider: model("fake/a", '{"themes":[]}'),
      artifacts: content,
      post,
      source,
    });
    expect(none.status === "proposed" && none.result.proposals).toEqual([]);

    const dup = await proposeThemes({
      provider: model(
        "fake/b",
        JSON.stringify({
          themes: [{ title: "Chemtrails" }, { title: "chemtrails!" }, { nope: 1 }],
        }),
      ),
      artifacts: content,
      post: { ...post, postId: "dup" },
      source,
    });
    if (dup.status !== "proposed") throw new Error(dup.status);
    expect(dup.result.proposals.map((p) => p.title)).toEqual(["Chemtrails"]);
    expect(dup.result.rejected.map((r) => [r.reason, r.stage])).toEqual([
      ["duplicate-title", "semantic"],
      ["malformed-theme", "schema"],
    ]);
    expect(dup.result.rejected[0].candidate.fields.title).toBe("chemtrails!");
  });

  it("reuses saved results without model calls; identity is title-based, not positional", async () => {
    const first = await proposeThemes({
      provider: model(
        "fake/a",
        JSON.stringify({ themes: [{ title: "A" }, { title: "Geoengineering" }] }),
      ),
      artifacts: content,
      post,
      source,
    });
    const rerun = await proposeThemes({
      provider: model("fake/a"),
      artifacts: content,
      post,
      source,
    });
    expect(rerun.status === "proposed" && rerun.reused).toBe(true);
    // A different model, different order: same title gives the same ID.
    const other = await proposeThemes({
      provider: model(
        "fake/c",
        JSON.stringify({ themes: [{ title: "Geoengineering", description: "x" }] }),
      ),
      artifacts: content,
      post,
      source,
    });
    if (first.status !== "proposed" || other.status !== "proposed") throw new Error();
    expect(other.result.proposals[0].id).toBe(first.result.proposals[1].id);
  });

  it("never writes the catalogue and keeps proposals unchanged when the catalogue changes", async () => {
    const catalogue = new ThemeCatalogueStore(content);
    const m = model("fake/a", JSON.stringify({ themes: [{ title: "Smart meters" }] }));
    const out = await proposeThemes({
      provider: m,
      artifacts: content,
      post,
      source,
      catalogue: { themes: [{ name: "Geoengineering" }], version: "v1" },
    });
    if (out.status !== "proposed") throw new Error(out.status);
    expect(m.calls[0]).toContain("Geoengineering"); // read-only context
    expect((await catalogue.load()).ref).toBeUndefined(); // nothing written
    // Downstream remapping writes elsewhere; the saved proposal is untouched.
    await catalogue.register([
      { name: "Smart meters", definition: "d", aliases: [], origin: "seed" },
    ]);
    const reread = parseThemeProposalResult(JSON.parse(await content.read(out.ref)));
    expect(reread).toEqual(out.result);
  });

  it("rejects malformed output and incompatible saved versions", async () => {
    const bad = await proposeThemes({
      provider: model("fake/a", "nope", '{"themes": 5}'),
      artifacts: content,
      post,
      source,
    });
    expect(bad).toMatchObject({ status: "failed", reason: "malformed-output", attempts: 2 });
    expect(() => parseThemeProposalResult({ schemaVersion: 0 })).toThrow(
      IncompatibleThemeResultError,
    );
    expect(() => parseThemeProposalResult({ schemaVersion: 1, proposals: "x" })).toThrow();
  });
});
