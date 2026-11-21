import { describe, expect, it } from "vite-plus/test";
import { assertArtifactPath } from "../../src/controllers/artifact-store.js";
import {
  articleId,
  articlePaths,
  classifyArticlePath,
  isCanonicalArticlePath,
} from "../../src/drafting/article-identity.js";

const post = { publicationId: "example-pub", postId: "a-synthetic-post" };

describe("stable article identity (#578)", () => {
  it("is deterministic and independent of generation inputs", () => {
    const id = articleId(post);
    expect(id).toMatch(/^article-[0-9a-f]{24}$/);
    // A retry or redraft asks for the same logical article: same ID.
    expect(articleId({ ...post })).toBe(id);
    expect(articleId({ ...post, edition: "primary" })).toBe(id);
  });

  it("gives independent editorial articles about one source separate IDs", () => {
    expect(articleId({ ...post, edition: "follow-up" })).not.toBe(articleId(post));
    expect(articleId({ ...post, postId: "another-post" })).not.toBe(articleId(post));
    expect(articleId({ ...post, publicationId: "other-pub" })).not.toBe(articleId(post));
  });

  it("places canonical body and metadata at fixed, valid artifact paths", () => {
    const p = articlePaths(post);
    expect(p.body).toBe(`articles/example-pub/a-synthetic-post/${p.id}/article.md`);
    expect(p.metadata).toBe(`articles/example-pub/a-synthetic-post/${p.id}/article.json`);
    expect(() => assertArtifactPath(p.body)).not.toThrow();
    expect(() => assertArtifactPath(p.metadata)).not.toThrow();
  });

  it("classifies canonical and legacy hash-named paths without collision", () => {
    const p = articlePaths(post);
    expect(classifyArticlePath(p.body)).toMatchObject({
      kind: "canonical",
      id: p.id,
      part: "body",
    });
    expect(classifyArticlePath(p.metadata)).toMatchObject({ kind: "canonical", part: "metadata" });
    const legacy = `articles/example-pub/a-synthetic-post/${"0f".repeat(16)}.md`;
    expect(classifyArticlePath(legacy)).toMatchObject({
      kind: "legacy-generation",
      generationKey: "0f".repeat(16),
      part: "body",
    });
    // Existing drafts are never treated as in-place documents.
    expect(isCanonicalArticlePath(legacy)).toBe(false);
    expect(isCanonicalArticlePath(p.body)).toBe(true);
    for (const other of [
      "articles/example-pub/a-synthetic-post/notes.md",
      `articles/example-pub/a-synthetic-post/${p.id}/other.md`,
      "dossier/theme.md",
      `articles/example-pub/../${p.id}/article.md`,
    ]) {
      expect(classifyArticlePath(other)).toBeUndefined();
    }
  });

  it("rejects invalid identities", () => {
    expect(() => articleId({ publicationId: "Bad Pub", postId: "p" })).toThrow();
    expect(() => articleId({ ...post, edition: "../x" })).toThrow();
    // Segments must fit the artifact store's 255-character limit.
    expect(() => articlePaths({ publicationId: "a".repeat(256), postId: "p" })).toThrow();
    const longest = articlePaths({ publicationId: "a".repeat(255), postId: "p" });
    expect(() => assertArtifactPath(longest.body)).not.toThrow();
  });
});
