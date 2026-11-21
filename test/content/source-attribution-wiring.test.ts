import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  attributionIdentity,
  bylineAuthors,
  parseSourceMetadata,
  postAttribution,
  SourceMetadataError,
  sourceMetadataFromEnv,
} from "../../src/content/source-metadata.js";

// Synthetic configuration in the private document form (#482).
const DOCUMENT = {
  schemaVersion: 1,
  revision: 1,
  sources: [
    {
      id: "synthetic-feed",
      type: "substack",
      name: "Synthetic Feed",
      defaultAuthor: { id: "synthetic-author", name: "Synthetic Author" },
      attributionBasis: "owner-configured",
    },
  ],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steele-sources-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("source attribution wiring (#482)", () => {
  it("loads the document form with a stable author id, and the legacy array form", () => {
    const doc = parseSourceMetadata(DOCUMENT);
    expect(doc.bySource.get("synthetic-feed")).toMatchObject({
      defaultAuthor: "Synthetic Author",
      defaultAuthorId: "synthetic-author",
    });
    const legacy = parseSourceMetadata([
      { sourceId: "synthetic-feed", sourceType: "substack", displayName: "S", defaultAuthor: "A" },
    ]);
    expect(legacy.bySource.get("synthetic-feed")?.defaultAuthor).toBe("A");
  });

  it("resolves configured fallback, explicit byline override, ambiguity and missing config", () => {
    const m = parseSourceMetadata(DOCUMENT);
    expect(postAttribution(m, { publicationId: "synthetic-feed" })).toMatchObject({
      status: "resolved",
      author: "Synthetic Author",
      authorId: "synthetic-author",
      basis: "source-configured",
    });
    expect(
      postAttribution(m, { publicationId: "synthetic-feed", author: "Guest Writer" }),
    ).toMatchObject({
      status: "resolved",
      author: "Guest Writer",
      basis: "post-byline",
    });
    expect(
      postAttribution(m, { publicationId: "synthetic-feed", author: "A and B" }),
    ).toMatchObject({
      status: "unknown",
      reason: "ambiguous-byline",
    });
    expect(postAttribution(m, { publicationId: "unconfigured" })).toMatchObject({
      status: "unknown",
      reason: "no-byline-no-default",
    });
    // No configuration at all keeps legacy behaviour and identities.
    expect(postAttribution(undefined, { publicationId: "synthetic-feed" })).toBeUndefined();
    expect(bylineAuthors("A, B & C")).toEqual(["A", "B", "C"]);
  });

  it("changes identity when the configured default changes", () => {
    const a = postAttribution(parseSourceMetadata(DOCUMENT), { publicationId: "synthetic-feed" })!;
    const changed = structuredClone(DOCUMENT);
    changed.sources[0]!.defaultAuthor = { id: "other-author", name: "Synthetic Author" };
    const b = postAttribution(parseSourceMetadata(changed), { publicationId: "synthetic-feed" })!;
    // Same display name, different person: identities differ.
    expect(attributionIdentity(a)).not.toBe(attributionIdentity(b));
  });

  it("loads from the environment, refusing an invalid file with a fixed category", async () => {
    expect(sourceMetadataFromEnv({})).toBeUndefined();
    const good = join(dir, "sources.json");
    await writeFile(good, JSON.stringify(DOCUMENT));
    expect(sourceMetadataFromEnv({ STEELE_SOURCE_METADATA_PATH: good })?.bySource.size).toBe(1);
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ schemaVersion: 1, revision: 1, sources: [{ id: "x" }] }));
    try {
      sourceMetadataFromEnv({ STEELE_SOURCE_METADATA_PATH: bad });
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceMetadataError);
      expect(String(error)).not.toContain(dir);
    }
    expect(() =>
      sourceMetadataFromEnv({ STEELE_SOURCE_METADATA_PATH: join(dir, "missing.json") }),
    ).toThrow(SourceMetadataError);
  });
});
