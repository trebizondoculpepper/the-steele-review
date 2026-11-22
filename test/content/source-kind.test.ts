import { describe, expect, it } from "vite-plus/test";
import { sourceContextFor } from "../../src/content/source-context.js";

const record = {
  item: {
    publicationId: "example-site",
    postId: "a-post",
    url: "https://example.org/a-post",
    title: "T",
  },
  ingestionReason: "backfill" as const,
  text: "Some text.",
  complete: true,
  supplied: { articleHtml: "<p>Some text.</p>" },
  provenance: {
    sourceUrl: "https://example.org/a-post",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    method: "article-html",
  },
};
const ref = (path: string) => ({
  repository: "archive",
  commit: "a".repeat(40),
  path,
  sha256: "b".repeat(64),
});

describe("truthful source kind (#606)", () => {
  it("uses the validated capture namespace", () => {
    const c = sourceContextFor(record, ref("blog/example-site/a-post/collected.json"), undefined, {
      namespace: "blog/example-site",
    });
    expect(c.source).toMatchObject({
      type: "blog",
      namespace: "blog/example-site",
      typeBasis: "capture-namespace",
    });
  });

  it("keeps genuine Substack captures in their exact legacy shape", () => {
    const legacy = sourceContextFor(record, ref("substack/example-site/a-post/collected.json"));
    const viaNamespace = sourceContextFor(
      record,
      ref("substack/example-site/a-post/collected.json"),
      undefined,
      { namespace: "substack/example-site" },
    );
    expect(legacy.source.type).toBe("substack");
    expect(legacy.source).not.toHaveProperty("typeBasis");
    // Same identity whether or not the namespace was supplied.
    expect(viaNamespace).toEqual(legacy);
  });

  it("records an unestablished origin as unknown, never Substack", () => {
    const c = sourceContextFor(record, ref("other/a-post/collected.json"));
    expect(c.source).toMatchObject({ type: "unknown", typeBasis: "unknown" });
  });
});
