import { describe, expect, it } from "vite-plus/test";
import {
  attributionIdentity,
  authorVoiceAuthor,
  parseSourceMetadata,
  resolvePostAuthor,
  postAttribution,
} from "../../src/content/source-metadata.js";

// Synthetic sources only: no real publication names or URLs.
const registry = parseSourceMetadata([
  {
    sourceId: "synthetic-feed",
    sourceType: "substack",
    displayName: "Synthetic Feed",
    defaultAuthor: "Configured Author",
  },
  { sourceId: "synthetic-other", sourceType: "substack", displayName: "Synthetic Other" },
]);

describe("source metadata attribution (#462)", () => {
  it("prefers an explicit single post byline over the configured default", () => {
    const r = resolvePostAuthor({
      sourceId: "synthetic-feed",
      metadata: registry,
      byline: ["Post Author"],
    });
    expect(r).toMatchObject({ status: "resolved", author: "Post Author", basis: "post-byline" });
  });

  it("falls back to the configured source default", () => {
    const r = resolvePostAuthor({ sourceId: "synthetic-feed", metadata: registry });
    expect(r).toMatchObject({
      status: "resolved",
      author: "Configured Author",
      basis: "source-configured",
    });
  });

  it("stays unknown when there is no byline and no default", () => {
    const r = resolvePostAuthor({ sourceId: "synthetic-other", metadata: registry });
    expect(r).toMatchObject({ status: "unknown", reason: "no-byline-no-default" });
  });

  it("never collapses a multi-author byline to the default", () => {
    const r = resolvePostAuthor({
      sourceId: "synthetic-feed",
      metadata: registry,
      byline: ["Author One", "Author Two"],
    });
    expect(r).toMatchObject({ status: "unknown", reason: "ambiguous-byline" });
  });

  it("does not give a quoted speaker the post author", () => {
    const r = resolvePostAuthor({ sourceId: "synthetic-feed", metadata: registry });
    expect(authorVoiceAuthor("quoted", r)).toBeUndefined();
    expect(authorVoiceAuthor("uncertain", r)).toBeUndefined();
    expect(authorVoiceAuthor("author-voice", r)).toBe("Configured Author");
  });

  it("changes the attribution identity when configuration changes", () => {
    const before = attributionIdentity(
      resolvePostAuthor({ sourceId: "synthetic-feed", metadata: registry }),
    );
    const changed = parseSourceMetadata([
      {
        sourceId: "synthetic-feed",
        sourceType: "substack",
        displayName: "Synthetic Feed",
        defaultAuthor: "Different Author",
      },
    ]);
    const after = attributionIdentity(
      resolvePostAuthor({ sourceId: "synthetic-feed", metadata: changed }),
    );
    expect(after).not.toBe(before);
    expect(before).toMatch(
      /^source-configured:Configured Author:source-metadata-sha256:[0-9a-f]{64}$/,
    );
  });

  it("rejects a duplicate source identity in configuration", () => {
    expect(() =>
      parseSourceMetadata([
        { sourceId: "dup", sourceType: "substack", displayName: "One" },
        { sourceId: "dup", sourceType: "substack", displayName: "Two" },
      ]),
    ).toThrow(/configured twice/);
  });
  it.each(["array", "document"])(
    "resolves configured account labels in the %s format, preserving genuine people",
    (format) => {
      const source = {
        sourceId: "synthetic-feed",
        sourceType: "substack",
        displayName: "Synthetic Feed",
        defaultAuthor: "Configured Person",
        defaultAuthorId: "configured-person",
        sourceAccountBylines: ["Synthetic News and Views"],
      };
      const metadata = parseSourceMetadata(
        format === "array"
          ? [source]
          : {
              schemaVersion: 1,
              revision: 1,
              sources: [
                {
                  id: source.sourceId,
                  type: source.sourceType,
                  name: source.displayName,
                  defaultAuthor: { id: source.defaultAuthorId, name: source.defaultAuthor },
                  sourceAccountBylines: source.sourceAccountBylines,
                },
              ],
            },
      );
      expect(
        postAttribution(metadata, {
          publicationId: "synthetic-feed",
          author: "  SYNTHETIC News  and Views ",
        }),
      ).toMatchObject({
        author: "Configured Person",
        authorId: "configured-person",
        basis: "source-configured",
      });
      expect(
        postAttribution(metadata, { publicationId: "synthetic-feed", author: "Guest Person" }),
      ).toMatchObject({ author: "Guest Person", basis: "post-byline" });
      expect(
        postAttribution(metadata, {
          publicationId: "synthetic-feed",
          author: "Person One and Person Two",
        }),
      ).toMatchObject({ status: "unknown", reason: "ambiguous-byline" });
      expect(postAttribution(metadata, { publicationId: "unknown" })).toMatchObject({
        status: "unknown",
        reason: "no-byline-no-default",
      });
      const withoutAlias = parseSourceMetadata([{ ...source, sourceAccountBylines: undefined }]);
      expect(metadata.version).not.toBe(withoutAlias.version);
      const noPerson = parseSourceMetadata([
        { ...source, defaultAuthor: undefined, defaultAuthorId: undefined },
      ]);
      expect(
        postAttribution(noPerson, {
          publicationId: "synthetic-feed",
          author: "Synthetic News and Views",
        }),
      ).toMatchObject({ status: "unknown", reason: "no-byline-no-default" });
    },
  );
});
