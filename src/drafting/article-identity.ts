import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Stable article identity and canonical paths (#578, child of #488).
 *
 * A *logical article* is one editorial piece responding to one source post.
 * Its body and metadata live at fixed canonical paths that later revisions
 * edit in place; earlier versions remain readable through their exact Git
 * commits. This identity is deliberately separate from the *generation
 * identity* (the hash of package, model, prompt and revision inputs that keys
 * caching and safe retries): a retry of the same generation never creates a
 * second logical article, and a redraft never changes the article's ID.
 *
 * Independent editorial articles about the same source are distinguished by
 * an explicit edition slug; the default edition is `primary`.
 *
 * Existing hash-named drafts (`articles/<publication>/<post>/<32 hex>.md|json`)
 * keep their paths and exact commit/path/hash reads; nothing is migrated or
 * regenerated. The two layouts cannot collide: canonical files live one
 * directory deeper, under the article ID.
 *
 * Pure functions only: no Git or filesystem access here.
 */

export const ARTICLE_IDENTITY_VERSION = "article-identity-v1";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,254}$/);
const Edition = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const ArticleKeySchema = z
  .object({
    publicationId: Slug,
    postId: Slug,
    /** Distinguishes independent editorial articles about one source. */
    edition: Edition.default("primary"),
  })
  .strict();
export type ArticleKey = z.input<typeof ArticleKeySchema>;

const ARTICLE_ID = /^article-[0-9a-f]{24}$/;
export const ArticleIdSchema = z.string().regex(ARTICLE_ID);
export type ArticleId = z.infer<typeof ArticleIdSchema>;

/**
 * Deterministic logical article ID. Independent of the source revision, model,
 * prompt, package and revision feedback, so it survives redrafts and retries.
 */
export function articleId(key: ArticleKey): ArticleId {
  const k = ArticleKeySchema.parse(key);
  const digest = createHash("sha256")
    .update(JSON.stringify([ARTICLE_IDENTITY_VERSION, k.publicationId, k.postId, k.edition]))
    .digest("hex")
    .slice(0, 24);
  return `article-${digest}`;
}

export interface ArticlePaths {
  id: ArticleId;
  /** Directory holding the canonical files. */
  dir: string;
  /** Canonical Markdown body, edited in place by revisions. */
  body: string;
  /** Canonical metadata (publication fields, provenance), edited in place. */
  metadata: string;
}

/** Canonical body and metadata paths for a logical article. */
export function articlePaths(key: ArticleKey): ArticlePaths {
  const k = ArticleKeySchema.parse(key);
  const id = articleId(k);
  const dir = `articles/${k.publicationId}/${k.postId}/${id}`;
  return { id, dir, body: `${dir}/article.md`, metadata: `${dir}/article.json` };
}

const CANONICAL =
  /^articles\/([a-z0-9][a-z0-9-]{0,254})\/([a-z0-9][a-z0-9-]{0,254})\/(article-[0-9a-f]{24})\/article\.(md|json)$/;
const LEGACY =
  /^articles\/([a-z0-9][a-z0-9-]{0,254})\/([a-z0-9][a-z0-9-]{0,254})\/([0-9a-f]{32})\.(md|json)$/;

export type ArticlePathKind =
  | {
      kind: "canonical";
      publicationId: string;
      postId: string;
      id: ArticleId;
      part: "body" | "metadata";
    }
  | {
      kind: "legacy-generation";
      publicationId: string;
      postId: string;
      generationKey: string;
      part: "body" | "metadata";
    };

/**
 * Classify a stored article path. Canonical paths are the revisable in-place
 * documents; legacy generation paths are the existing write-once drafts.
 * Anything else is not an article document.
 */
export function classifyArticlePath(path: string): ArticlePathKind | undefined {
  const c = CANONICAL.exec(path);
  if (c) {
    return {
      kind: "canonical",
      publicationId: c[1]!,
      postId: c[2]!,
      id: c[3]!,
      part: c[4] === "md" ? "body" : "metadata",
    };
  }
  const l = LEGACY.exec(path);
  if (l) {
    return {
      kind: "legacy-generation",
      publicationId: l[1]!,
      postId: l[2]!,
      generationKey: l[3]!,
      part: l[4] === "md" ? "body" : "metadata",
    };
  }
  return undefined;
}

/** True only for canonical in-place article documents (never legacy drafts). */
export function isCanonicalArticlePath(path: string): boolean {
  return classifyArticlePath(path)?.kind === "canonical";
}
