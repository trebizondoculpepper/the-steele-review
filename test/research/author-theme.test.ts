import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { proposeThemes, sourceAuthorTheme } from "../../src/analysis/theme-proposals.js";
import type { CollectionRecord } from "../../src/collection/collection-store.js";
import { saveSourceContext, sourceContextFor } from "../../src/content/source-context.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import {
  parseSourceMetadata,
  resolvePostAuthor,
  type PostAuthorResolution,
} from "../../src/content/source-metadata.js";
import { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { ResearchRequest } from "../../src/research/job.js";
import { LexicalShortlister, assessPostCoverage } from "../../src/research/librarian.js";

// Synthetic configuration modelled on the owner's disambiguation case (#753).
const registry = parseSourceMetadata({
  schemaVersion: 1,
  revision: 1,
  sources: [
    {
      id: "pub",
      type: "substack",
      name: "Synthetic Campaign",
      sourceAccountBylines: ["Synthetic Campaign"],
      defaultAuthor: {
        id: "mark-steele",
        name: "Mark Steele",
        label: "Save Us Now campaigner",
        description: "Mark Steele, the Save Us Now campaigner who runs this source.",
        excludes: ["Mark Steel, the comedian and BBC broadcaster"],
      },
    },
  ],
});
const TEXT = "Synthetic post text about towers and claims.";

let dir: string;
let content: GitArtifactStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-author-theme-"));
  content = new GitArtifactStore({ repoPath: dir, repository: "content" });
  await content.initialise();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const resolve = (byline?: string[]) =>
  resolvePostAuthor({ metadata: registry, sourceId: "pub", ...(byline ? { byline } : {}) });

/** Save a capture and its source context, then propose themes for it. */
async function themesFor(postId: string, attribution: PostAuthorResolution, modelThemes: string[]) {
  const record: CollectionRecord = {
    item: { publicationId: "pub", postId, url: `https://pub.example/p/${postId}`, title: "T" },
    ingestionReason: "live",
    text: TEXT,
    complete: true,
    supplied: {},
    provenance: {
      sourceUrl: `https://pub.example/p/${postId}`,
      acquiredAt: "2026-01-01T00:00:00Z",
      method: "article-html",
    },
  };
  const capture = await content.write(
    `substack/pub/${postId}/collected.json`,
    JSON.stringify(record),
  );
  const context = await saveSourceContext(content, sourceContextFor(record, capture, attribution));
  const out = await proposeThemes({
    provider: {
      modelVersion: "fake/m",
      complete: async () =>
        JSON.stringify({ themes: modelThemes.map((title) => ({ title, description: title })) }),
    },
    artifacts: content,
    sourceContext: context,
    post: { publicationId: "pub", postId },
    source: {
      text: TEXT,
      sourceVersion: sourceVersionFor(TEXT),
      artifact: {
        repository: capture.repository,
        commit: capture.commit,
        path: capture.path,
        hash: `sha256:${capture.sha256}`,
      },
    },
  });
  if (out.status !== "proposed") throw new Error(out.status);
  return out;
}

/** A claim extraction attaching one claim to the author theme. */
async function claimsFor(postId: string, themeResult: Awaited<ReturnType<typeof themesFor>>) {
  const authorId = themeResult.result.proposals.find((p) => p.origin === "source-author")!.id;
  return content.write(
    `claim-extractions/pub/${postId}/r.json`,
    JSON.stringify({
      schemaVersion: 2,
      post: { publicationId: "pub", postId },
      sourceVersion: sourceVersionFor(TEXT),
      themeIds: [authorId],
      themeResult: `${themeResult.ref.commit}:${themeResult.ref.path}`,
      claims: [
        {
          claim: { statement: `The author of ${postId} has campaigned for years` },
          occurrence: {},
          kind: "assertion",
          themeIds: [authorId],
          classification: "themed",
          claimRecordId: `claim-${postId}`,
        },
      ],
      candidates: [],
      rejected: [],
      extraction: { modelVersion: "m", promptVersion: "p", extractedAt: "2026-01-01T00:00:00Z" },
    }),
  );
}

describe("known source authors as ordinary themes (#753)", () => {
  it("resolves the configured author with its owner profile; other bylines get none", () => {
    expect(resolve()).toMatchObject({
      status: "resolved",
      author: "Mark Steele",
      basis: "source-configured",
      profile: { label: "Save Us Now campaigner" },
    });
    // The same name in a byline is the same configured person.
    expect(resolve(["Mark Steele"])).toMatchObject({ basis: "post-byline", profile: {} });
    // A different byline is a different person, unprofiled.
    expect(resolve(["Someone Else"])).not.toHaveProperty("profile");
    expect(resolve(["A", "B"])).toMatchObject({ status: "unknown" });
  });

  it("builds a disambiguated theme, and none for an unknown author", () => {
    const theme = sourceAuthorTheme(
      sourceContextFor(
        {
          item: { publicationId: "pub", postId: "x", url: "https://pub.example/p/x", title: "T" },
          ingestionReason: "live",
          text: TEXT,
          complete: true,
          supplied: {},
          provenance: {
            sourceUrl: "https://pub.example/p/x",
            acquiredAt: "2026-01-01T00:00:00Z",
            method: "article-html",
          },
        },
        {
          repository: "c",
          commit: "a".repeat(40),
          path: "substack/pub/x/collected.json",
          sha256: "b".repeat(64),
        },
        resolve(),
      ),
    );
    expect(theme?.title).toBe("Mark Steele (Save Us Now campaigner)");
    expect(theme?.description).toContain("Save Us Now campaigner who runs this source");
    expect(theme?.description).toContain(
      "Not to be confused with: Mark Steel, the comedian and BBC broadcaster.",
    );
    expect(theme?.description).toContain("not biographical evidence");
    expect(sourceAuthorTheme(undefined)).toBeUndefined();
  });

  it("adds the author to the proposals; an unknown author adds nothing", async () => {
    const known = await themesFor("p1", resolve(), ["Towers"]);
    expect(known.result.proposals.map((p) => [p.title, p.origin ?? "model"])).toEqual([
      ["Towers", "model"],
      ["Mark Steele (Save Us Now campaigner)", "source-author"],
    ]);
    const unknown = await themesFor("p2", resolve(["A", "B"]), ["Towers"]);
    expect(unknown.result.proposals.some((p) => p.origin === "source-author")).toBe(false);
  });

  it("maps the author through the normal catalogue, reuses its dossier, and names the person in research", async () => {
    const requests: ResearchRequest[] = [];
    const commission = async (request: ResearchRequest) => {
      requests.push(request);
      return { jobId: "busy", status: "busy" as const };
    };
    const first = await themesFor("p1", resolve(), ["Towers"]);
    const one = await assessPostCoverage({
      artifacts: content,
      themeResult: first.ref,
      claimResult: await claimsFor("p1", first),
      commission,
      shortlister: new LexicalShortlister(),
    });
    const authorMapping = one.record.mappings.find((m) =>
      m.title.startsWith("Mark Steele (Save Us Now campaigner)"),
    )!;
    expect(authorMapping).toBeDefined();
    // The research question carries the disambiguation.
    expect(requests.at(-1)!.question).toContain("Mark Steel, the comedian and BBC broadcaster");

    // A second post by the same author maps to the same theme and dossier.
    const second = await themesFor("p3", resolve(), ["Masts"]);
    const two = await assessPostCoverage({
      artifacts: content,
      themeResult: second.ref,
      claimResult: await claimsFor("p3", second),
      commission,
      shortlister: new LexicalShortlister(),
    });
    expect(
      two.record.mappings.find((m) => m.title.startsWith("Mark Steele (Save Us Now"))!.dossierId,
    ).toBe(authorMapping.dossierId);
  });
});
