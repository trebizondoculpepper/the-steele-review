import { describe, expect, it } from "vite-plus/test";
import {
  attributionIdentity,
  authorVoiceAuthor,
  parseSourceMetadata,
  resolvePostAuthor,
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
    expect(before).toMatch(/^source-configured:Configured Author:source-metadata-sha256:[0-9a-f]{64}$/);
  });

  it("rejects a duplicate source identity in configuration", () => {
    expect(() =>
      parseSourceMetadata([
        { sourceId: "dup", sourceType: "substack", displayName: "One" },
        { sourceId: "dup", sourceType: "substack", displayName: "Two" },
      ]),
    ).toThrow(/configured twice/);
  });
});
