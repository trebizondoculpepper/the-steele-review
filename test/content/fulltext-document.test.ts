import { describe, expect, it } from "vite-plus/test";
import {
  FULLTEXT_INDEX_MAPPING,
  FULLTEXT_INDEX_V1,
  FULLTEXT_SCHEMA_VERSION,
  createFulltextDocument,
  fulltextDocumentJsonSchema,
  fulltextDocumentId,
  fulltextIndexRequest,
  parseFulltextDocument,
  sourceVersionFor,
} from "../../src/content/fulltext-document.js";
import type { SubstackItem } from "../../src/content/substack-item.js";

// Synthetic values only.
const item: SubstackItem = {
  publicationId: "example-pub",
  postId: "a-synthetic-post",
  url: "https://example-pub.substack.com/p/a-synthetic-post",
  title: "A synthetic post",
  publishedAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-01-03T00:00:00+01:00",
};

const artifact = {
  repository: "synthetic-archive",
  commit: "0123456789abcdef0123456789abcdef01234567",
  path: "sources/example-pub/a-synthetic-post.txt",
  hash: `sha256:${"ab".repeat(32)}`,
};

const text = "A synthetic paragraph, retained verbatim.\n\nA second synthetic paragraph.";

const build = (overrides: Partial<Parameters<typeof createFulltextDocument>[0]> = {}) =>
  createFulltextDocument(
    {
      item,
      text,
      acquisitionOrigin: "rss-content",
      artifact,
      sourceRetrievedAt: "2026-02-01T00:00:00Z",
      ...overrides,
    },
    () => new Date("2026-02-02T03:04:05.000Z"),
  );

describe("FulltextDocument", () => {
  it("projects an explicit byline additively and leaves legacy documents unattributed", () => {
    expect(build({ item: { ...item, author: "Guest Author" } }).author).toBe("Guest Author");
    expect(FULLTEXT_INDEX_MAPPING.properties.author).toEqual({ type: "keyword" });
    expect(build()).not.toHaveProperty("author");
  });
  it("builds a complete document carrying identity, text and provenance", () => {
    const doc = build();
    expect(doc).toEqual({
      schemaVersion: FULLTEXT_SCHEMA_VERSION,
      publicationId: "example-pub",
      postId: "a-synthetic-post",
      url: item.url,
      title: item.title,
      publishedAt: item.publishedAt,
      updatedAt: item.updatedAt,
      text,
      acquisitionOrigin: "rss-content",
      sourceVersion: sourceVersionFor(text),
      sourceRetrievedAt: "2026-02-01T00:00:00Z",
      indexedAt: "2026-02-02T03:04:05.000Z",
      artifact,
    });
    expect(parseFulltextDocument(doc)).toEqual(doc);
  });

  it("omits dates the source did not supply instead of inventing them", () => {
    const withoutDates: Record<string, unknown> = { ...item };
    delete withoutDates.publishedAt;
    delete withoutDates.updatedAt;
    const doc = build({ item: withoutDates as SubstackItem });
    expect(doc).not.toHaveProperty("publishedAt");
    expect(doc).not.toHaveProperty("updatedAt");
    expect(doc.sourceRetrievedAt).toBe("2026-02-01T00:00:00Z");
  });

  it.each(["rss-content", "archive-fetch", "transcript"] as const)(
    "records acquisition origin %s",
    (acquisitionOrigin) => {
      expect(build({ acquisitionOrigin }).acquisitionOrigin).toBe(acquisitionOrigin);
    },
  );

  it("rejects an unknown acquisition origin", () => {
    expect(() => build({ acquisitionOrigin: "manual-paste" as never })).toThrow();
  });

  it("rejects empty text rather than indexing a placeholder", () => {
    expect(() => build({ text: "" })).toThrow();
  });

  it("ignores a caller-supplied source version and hashes the text instead", () => {
    const doc = build({ text: "different synthetic text" });
    expect(doc.sourceVersion).toBe(sourceVersionFor("different synthetic text"));
  });

  it.each([
    ["non-canonical url", { item: { ...item, url: "http://example-pub.substack.com/p/a" } }],
    ["empty title", { item: { ...item, title: "  " } }],
    ["bad sourceRetrievedAt", { sourceRetrievedAt: "2026-02-01" }],
    ["absolute artifact path", { artifact: { ...artifact, path: "/private/example.txt" } }],
    [
      "parent-traversal artifact path",
      { artifact: { ...artifact, path: "sources/../../example.txt" } },
    ],
    ["short commit", { artifact: { ...artifact, commit: "abc123" } }],
    ["unhashed artifact", { artifact: { ...artifact, hash: artifact.hash.slice(7) } }],
  ])("rejects %s", (_name, overrides) => {
    expect(() =>
      build(overrides as Partial<Parameters<typeof createFulltextDocument>[0]>),
    ).toThrow();
  });

  it("rejects documents with event or unknown fields", () => {
    const doc = build();
    expect(() => parseFulltextDocument({ ...doc, ingestionReason: "live" })).toThrow();
    expect(() => parseFulltextDocument({ ...doc, vector: [0.1, 0.2] })).toThrow();
    expect(() => parseFulltextDocument(null)).toThrow();
  });
});

describe("document identity and retries", () => {
  it("derives the document ID from content identity only", () => {
    expect(fulltextDocumentId(build())).toBe("substack:example-pub:a-synthetic-post");
    expect(fulltextDocumentId({ publicationId: "example-pub", postId: "a-synthetic-post" })).toBe(
      fulltextDocumentId(build()),
    );
  });

  it("addresses the same document on retry, so nothing is appended", () => {
    const indexedAt = () => new Date("2026-02-02T03:04:05.000Z");
    const first = build({ text });
    const retry = createFulltextDocument(
      {
        item,
        text,
        acquisitionOrigin: "rss-content",
        artifact,
        sourceRetrievedAt: "2026-02-01T00:00:00Z",
      },
      indexedAt,
    );
    const a = fulltextIndexRequest(first);
    const b = fulltextIndexRequest(retry);
    expect(a.index._id).toBe(b.index._id);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("replaces the document deliberately when the source text changes", () => {
    const v1 = fulltextIndexRequest(build({ text: "First synthetic version." }));
    const v2 = fulltextIndexRequest(build({ text: "Second synthetic version." }));
    expect(v2.index._id).toBe(v1.index._id);
    expect(v2.document.sourceVersion).not.toBe(v1.document.sourceVersion);
  });

  it("uses the versioned index by default and permits an explicit one", () => {
    const doc = build();
    expect(fulltextIndexRequest(doc).index._index).toBe(FULLTEXT_INDEX_V1);
    expect(fulltextIndexRequest(doc, "synthetic-reindex").index._index).toBe("synthetic-reindex");
  });
});

describe("Elasticsearch mapping", () => {
  it("declares every schema field and no extras", () => {
    const schema = fulltextDocumentJsonSchema() as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(FULLTEXT_INDEX_MAPPING.properties).sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
    expect(FULLTEXT_INDEX_MAPPING.dynamic).toBe("strict");
  });

  it("maps timestamps as dates and identifiers as keywords in agreement with the schema", () => {
    const schema = fulltextDocumentJsonSchema() as {
      properties: Record<string, { format?: string; type?: string | string[] }>;
      required: string[];
    };
    const required = new Set(schema.required);
    const properties = FULLTEXT_INDEX_MAPPING.properties;

    for (const [field, prop] of Object.entries(schema.properties)) {
      const formats = Array.isArray(prop.type) ? [] : [prop.format];
      if (formats.includes("date-time")) {
        expect(properties[field]?.type, `${field} must be an ES date`).toBe("date");
        // Dates may be optional in the schema; the mapping never marks them required.
        if (!required.has(field)) expect(required.has(field)).toBe(false);
      }
    }

    for (const field of ["publicationId", "postId", "url", "sourceVersion", "acquisitionOrigin"]) {
      expect(properties[field]?.type, `${field} must be a keyword`).toBe("keyword");
    }
    expect(properties.text?.type).toBe("text");
    expect(properties.title?.type).toBe("text");
    expect(properties.title?.fields?.keyword?.type).toBe("keyword");
  });

  it("declares artifact sub-fields as keywords", () => {
    const artifactMapping = FULLTEXT_INDEX_MAPPING.properties.artifact;
    expect(artifactMapping?.type).toBe("object");
    expect(Object.keys(artifactMapping?.properties ?? {}).sort()).toEqual([
      "commit",
      "hash",
      "path",
      "repository",
    ]);
    for (const field of Object.values(artifactMapping?.properties ?? {})) {
      expect(field.type).toBe("keyword");
    }
  });

  it("defines no vector or semantic fields", () => {
    const json = JSON.stringify(FULLTEXT_INDEX_MAPPING);
    expect(json).not.toMatch(/dense_vector|knn|semantic/i);
  });
});
