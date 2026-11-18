import { describe, expect, it } from "vite-plus/test";
import {
  parseSubstackItem,
  postIdFromCanonicalUrl,
  substackItemJsonSchema,
} from "../../src/content/substack-item.js";

// Synthetic values only.
const valid = {
  publicationId: "example-pub",
  postId: "a-synthetic-post",
  url: "https://example-pub.substack.com/p/a-synthetic-post",
  title: "A synthetic post",
  publishedAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-01-03T00:00:00+01:00",
};

describe("SubstackItem schema", () => {
  it("accepts a complete item", () => {
    expect(parseSubstackItem(valid)).toEqual(valid);
  });

  it("accepts an item without dates and leaves them absent", () => {
    const minimal: Record<string, unknown> = { ...valid };
    delete minimal.publishedAt;
    delete minimal.updatedAt;
    const item = parseSubstackItem(minimal);
    expect(item).not.toHaveProperty("publishedAt");
    expect(item).not.toHaveProperty("updatedAt");
  });

  it.each(["publicationId", "postId", "url", "title"])("rejects missing %s", (field) => {
    const input: Record<string, unknown> = { ...valid };
    delete input[field];
    expect(() => parseSubstackItem(input)).toThrow();
  });

  it.each([
    ["publicationId", "Upper.Case"],
    ["postId", "has spaces"],
    ["postId", ""],
    ["url", "http://example-pub.substack.com/p/a-synthetic-post"],
    ["url", "not a url"],
    ["title", "   "],
    ["publishedAt", "2026-01-02"],
    ["publishedAt", "yesterday"],
    ["updatedAt", 1767323045],
  ])("rejects invalid %s %j", (field, value) => {
    expect(() => parseSubstackItem({ ...valid, [field]: value })).toThrow();
  });

  it("rejects unknown fields such as event or body data", () => {
    expect(() => parseSubstackItem({ ...valid, ingestionReason: "live" })).toThrow();
    expect(() => parseSubstackItem({ ...valid, body: "<p>text</p>" })).toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => parseSubstackItem(null)).toThrow();
    expect(() => parseSubstackItem("item")).toThrow();
  });
});

describe("postIdFromCanonicalUrl", () => {
  it("extracts the slug", () => {
    expect(postIdFromCanonicalUrl("https://example-pub.substack.com/p/a-synthetic-post")).toBe(
      "a-synthetic-post",
    );
    expect(postIdFromCanonicalUrl("https://example.org/p/Another-Post/")).toBe("another-post");
  });

  it("returns undefined for other shapes", () => {
    expect(postIdFromCanonicalUrl("https://example.org/archive")).toBeUndefined();
    expect(postIdFromCanonicalUrl("not a url")).toBeUndefined();
  });
});

describe("JSON Schema export", () => {
  it("documents every field and required set", () => {
    const schema = substackItemJsonSchema() as {
      properties: Record<string, { description?: string }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required.sort()).toEqual(["postId", "publicationId", "title", "url"]);
    expect(schema.additionalProperties).toBe(false);
    for (const [name, prop] of Object.entries(schema.properties)) {
      expect(prop.description, name).toBeTruthy();
    }
  });
});
