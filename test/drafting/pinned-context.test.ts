import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExtractionModelProvider } from "../../src/analysis/extraction.js";
import { proposeThemes } from "../../src/analysis/theme-proposals.js";
import { collectionArtifactPath } from "../../src/collection/collection-store.js";
import { sourceVersionFor } from "../../src/content/fulltext-document.js";
import { GitArtifactStore, type ArtifactRef } from "../../src/controllers/artifact-store.js";
import { BRIEF_SCHEMA_VERSION, type DraftingBrief } from "../../src/drafting/brief.js";
import { draftFromBrief } from "../../src/drafting/draft.js";
import { loadPinnedContext, type PinnedContext } from "../../src/drafting/pinned-context.js";
import { verifyDraft } from "../../src/drafting/verify.js";

const BEYOND = "Later in the post the author describes a protest march through the city.";
const TEXT = `The towers emit dangerous radiation. ${BEYOND}`;
const item = { publicationId: "pub", postId: "p", url: "https://pub.example.com/p/p", title: "T" };
const h = (c: string) => `sha256:${c.repeat(64)}`;

let dir: string;
let archive: GitArtifactStore;
let content: GitArtifactStore;
let sourceRef: ArtifactRef;
let themesRef: ArtifactRef;

const provider = (...responses: string[]): ExtractionModelProvider & { calls: string[] } => {
  const calls: string[] = [];
  return {
    modelVersion: "fake/m",
    calls,
    async complete(req) {
      calls.push(req.user);
      const next = responses.shift();
      if (next === undefined) throw new Error("none");
      return next;
    },
  };
};

async function writeSource(text: string, postId = "p"): Promise<ArtifactRef> {
  const it = { ...item, postId, url: `https://pub.example.com/p/${postId}` };
  return archive.write(
    collectionArtifactPath(it),
    JSON.stringify({
      item: it,
      ingestionReason: "backfill",
      text,
      complete: true,
      supplied: {},
      provenance: {
        sourceUrl: it.url,
        acquiredAt: "2026-01-01T00:00:00.000Z",
        method: "article-html",
      },
    }),
  );
}

function briefFor(ref: ArtifactRef, text = TEXT): DraftingBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    source: {
      publicationId: "pub",
      postId: "p",
      url: "https://pub.example.com/p/p",
      sourceVersion: sourceVersionFor(text),
      artifact: {
        repository: ref.repository,
        commit: ref.commit,
        path: ref.path,
        hash: `sha256:${ref.sha256}`,
      },
      ingestionReason: "backfill",
    },
    claims: [
      {
        claimId: h("c"),
        statement: "The towers emit dangerous radiation.",
        passage: "The towers emit dangerous radiation.",
        span: { start: 0, end: 36 },
        citationIds: ["E1"],
        limitations: [],
        gaps: [],
        assessment: { status: "complete", omittedEntries: [], rejectedItems: 0 },
        unresolved: [],
      },
    ],
    citations: [
      {
        citationId: "E1",
        entryId: "towers",
        entryRevision: 1,
        entryArtifact: {
          repository: "research",
          commit: "e".repeat(40),
          path: "r.json",
          hash: h("f"),
        },
        evidence: {
          kind: "external",
          url: "https://example.org/survey",
          title: "Synthetic survey",
          retrievedAt: "2026-10-01T00:00:00Z",
          lastCheckedAt: "2026-10-01T00:00:00Z",
          passage: "Measured exposure stayed far below safety limits.",
        },
      },
    ],
    history: [],
    evidenceGaps: [],
  } as DraftingBrief;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-pinned-"));
  archive = new GitArtifactStore({ repoPath: join(dir, "a"), repository: "archive" });
  content = new GitArtifactStore({ repoPath: join(dir, "c"), repository: "content" });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "a"));
  await mkdir(join(dir, "c"));
  await archive.initialise();
  await content.initialise();
  sourceRef = await writeSource(TEXT);
  const themes = await proposeThemes({
    provider: provider(
      '{"themes":[{"title":"5G health concerns","description":"Radiation fears."}]}',
    ),
    artifacts: content,
    post: { publicationId: "pub", postId: "p" },
    source: {
      text: TEXT,
      sourceVersion: sourceVersionFor(TEXT),
      artifact: {
        repository: sourceRef.repository,
        commit: sourceRef.commit,
        path: sourceRef.path,
        hash: `sha256:${sourceRef.sha256}`,
      },
    },
  });
  if (themes.status !== "proposed") throw new Error(themes.status);
  themesRef = themes.ref;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function loaded(brief = briefFor(sourceRef)): Promise<PinnedContext> {
  const out = await loadPinnedContext({ archive, content, brief, themes: themesRef });
  if (out.kind !== "loaded") throw new Error(out.kind);
  return out.context;
}

const DRAFT = JSON.stringify({
  summary: "The post says towers emit radiation and describes a protest march.",
  themes: ["5G health concerns"],
  errors: [
    {
      claimId: h("c"),
      explanation: "Survey measurements were far below limits [E1].",
      citationIds: ["E1"],
      uncertainty: "low",
    },
  ],
});

describe("pinned source and theme context", () => {
  it("gives the writer and the verifier the same whole-post context, beyond the selected snippets", async () => {
    const context = await loaded();
    expect(context.themes.proposals.map((t) => t.title)).toEqual(["5G health concerns"]);
    const writer = provider(DRAFT);
    const drafted = await draftFromBrief({ brief: briefFor(sourceRef), provider: writer, context });
    expect(drafted.kind).toBe("drafted");
    expect(writer.calls[0]).toContain(BEYOND);
    expect(writer.calls[0]).toContain("never use it to confirm its own statements");
    if (drafted.kind !== "drafted") throw new Error();

    const markdown = drafted.markdown;
    const draftRef = {
      repository: "content",
      commit: "d".repeat(40),
      path: "drafts/x.md",
      sha256: createHash("sha256").update(markdown).digest("hex"),
    };
    const briefText = JSON.stringify(briefFor(sourceRef));
    const briefRef = {
      repository: "content",
      commit: "b".repeat(40),
      path: "briefs/x.json",
      sha256: createHash("sha256").update(briefText).digest("hex"),
    };
    const metadata = {
      draftHash: `sha256:${draftRef.sha256}`,
      brief: {
        repository: "content",
        commit: briefRef.commit,
        path: briefRef.path,
        hash: `sha256:${briefRef.sha256}`,
      },
      contextRef: context.contextRef,
    };
    const verifier = provider('{"verdict":"approve","issues":[]}');
    const verified = await verifyDraft({
      markdown,
      draft: draftRef,
      briefText,
      briefRef,
      metadata,
      verifier,
      context,
    });
    expect(verified.kind).toBe("report");
    expect(verifier.calls[0]).toContain(BEYOND);
    expect(verifier.calls[0]).toContain("5G health concerns"); // verifier sees the same themes
    if (verified.kind === "report") expect(verified.report.contextRef).toBe(context.contextRef);

    // Stale or missing context cannot be substituted at verification.
    const other = { ...context, contextRef: "sha256:other" };
    expect(
      (
        await verifyDraft({
          markdown,
          draft: draftRef,
          briefText,
          briefRef,
          metadata,
          verifier: provider(),
          context: other,
        })
      ).kind,
    ).toBe("invalid");
    expect(
      (
        await verifyDraft({
          markdown,
          draft: draftRef,
          briefText,
          briefRef,
          metadata,
          verifier: provider(),
        })
      ).kind,
    ).toBe("invalid");
  });

  it("rejects a source whose hash or version does not match the brief", async () => {
    const tampered = briefFor({ ...sourceRef, sha256: "0".repeat(64) });
    expect(
      (await loadPinnedContext({ archive, content, brief: tampered, themes: themesRef })).kind,
    ).toBe("unreadable");
    const wrongVersion = briefFor(sourceRef, "some other text");
    expect(
      (await loadPinnedContext({ archive, content, brief: wrongVersion, themes: themesRef })).kind,
    ).toBe("source-mismatch");
    const context = await loaded();
    expect(
      (await draftFromBrief({ brief: wrongVersion, provider: provider(), context })).kind ===
        "failed",
    ).toBe(true);
  });

  it("rejects a theme result for another source and refuses to truncate an overlarge source", async () => {
    const otherText = "A different post entirely.";
    const otherSource = await writeSource(otherText, "q");
    const otherThemes = await proposeThemes({
      provider: provider('{"themes":[{"title":"Other"}]}'),
      artifacts: content,
      post: { publicationId: "pub", postId: "q" },
      source: {
        text: otherText,
        sourceVersion: sourceVersionFor(otherText),
        artifact: {
          repository: "archive",
          commit: otherSource.commit,
          path: otherSource.path,
          hash: `sha256:${otherSource.sha256}`,
        },
      },
    });
    if (otherThemes.status !== "proposed") throw new Error();
    expect(
      (
        await loadPinnedContext({
          archive,
          content,
          brief: briefFor(sourceRef),
          themes: otherThemes.ref,
        })
      ).kind,
    ).toBe("theme-mismatch");
    expect(
      await loadPinnedContext({
        archive,
        content,
        brief: briefFor(sourceRef),
        themes: themesRef,
        maxSourceChars: 10,
      }),
    ).toMatchObject({
      kind: "source-too-large",
      chars: TEXT.length,
      maxChars: 10,
    });
  });

  it("gives changed context a distinguishable reference and keeps librarian mappings alongside proposals", async () => {
    const a = await loaded();
    const mapped = await loadPinnedContext({
      archive,
      content,
      brief: briefFor(sourceRef),
      themes: themesRef,
      canonicalMapping: new Map([[a.themes.proposals[0].id, "five-g-health"]]),
    });
    if (mapped.kind !== "loaded") throw new Error();
    expect(mapped.context.contextRef).not.toBe(a.contextRef); // mapping is part of identity
    expect(mapped.context.themes.proposals[0]).toMatchObject({
      title: "5G health concerns",
      canonicalId: "five-g-health",
    });

    const newerThemes = await proposeThemes({
      provider: provider('{"themes":[{"title":"Electromagnetic fears"}]}'),
      prompt: { version: "theme-proposals-test", instructions: "x" },
      artifacts: content,
      post: { publicationId: "pub", postId: "p" },
      source: {
        text: TEXT,
        sourceVersion: sourceVersionFor(TEXT),
        artifact: briefFor(sourceRef).source.artifact,
      },
    });
    if (newerThemes.status !== "proposed") throw new Error();
    const b = await loadPinnedContext({
      archive,
      content,
      brief: briefFor(sourceRef),
      themes: newerThemes.ref,
    });
    if (b.kind !== "loaded") throw new Error();
    expect(b.context.contextRef).not.toBe(a.contextRef);
  });
});
