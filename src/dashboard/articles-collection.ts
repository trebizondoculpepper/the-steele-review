import { z } from "zod";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { CollectionAdapter, CollectionPage, CollectionRow } from "./collection-query.js";
import type { DraftEntry, DraftInventoryPort } from "./drafts.js";

/**
 * Logical articles through the shared collection contract (#621, on #617).
 *
 * One row per logical article: its current version only, never a flat row
 * per generation; history stays separately discoverable on the article page.
 * Approval is shown exactly as the drafts reader binds it: a body-only
 * approval is its own state, so changed title/subtitle/excerpt never inherit
 * publication approval. Drafts made before logical articles existed are a
 * separate category. Read-only: no model calls, no writes.
 */

type Store = Pick<GitArtifactStore, "lookup">;

export type ArticleApproval =
  | "approved"
  | "body-only-approved"
  | "redraft"
  | "unverified"
  | "incomplete"
  | "unreadable";

export type ArticleBrowseRow = CollectionRow & {
  category: "article" | "legacy-draft";
  approval: ArticleApproval;
  publicationId: string;
  postId: string;
  subtitle?: string;
  excerpt?: string;
  draftedAt?: string;
  /** Logical article identity and current version number. */
  article?: { id: string; version: number };
};

export const approvalOf = (e: DraftEntry): ArticleApproval =>
  e.status === "approved"
    ? e.approvalScope === "body-only"
      ? "body-only-approved"
      : "approved"
    : e.status;

const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

const Cursor = z
  .object({
    k: z.enum(["article", "legacy-draft"]),
    after: z.string().optional(),
    skip: z.number().int().min(0),
  })
  .strict();
type CursorValue = z.infer<typeof Cursor>;
const encode = (c: CursorValue) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decode(raw: string): CursorValue | undefined {
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,299}$/;

export function articlesCollection(
  drafts: DraftInventoryPort,
  content: Store,
): CollectionAdapter & {
  search(
    query: Parameters<CollectionAdapter["search"]>[0],
  ): Promise<CollectionPage & { rows: ArticleBrowseRow[] }>;
} {
  return {
    name: "articles",
    filters: {
      category: {
        schema: z.enum(["article", "legacy-draft"]),
        description: "Logical articles (current version) or drafts made before logical articles",
      },
      approval: {
        schema: z.enum([
          "approved",
          "body-only-approved",
          "redraft",
          "unverified",
          "incomplete",
          "unreadable",
        ]),
        description: "Exact approval state of the shown version",
      },
      publication: { schema: z.string().regex(ID), description: "Publication ID" },
    },
    sorts: ["stored"],
    async search(query) {
      const f = query.filters as {
        category?: "article" | "legacy-draft";
        approval?: ArticleApproval;
        publication?: string;
      };
      const category = f.category ?? "article";
      const limitations: string[] = [];
      let cursor = query.cursor ? decode(query.cursor) : undefined;
      if (query.cursor && (!cursor || cursor.k !== category)) {
        limitations.push("The page link was not valid for this list; showing the first page.");
        cursor = undefined;
      }
      const page = await drafts.page({
        ...(cursor?.after ? { after: cursor.after } : {}),
        ...(f.publication ? { publicationId: f.publication } : {}),
      });
      const text = query.text?.toLowerCase();
      const rows: ArticleBrowseRow[] = [];
      let consumed = cursor?.skip ?? 0;
      for (const e of page.entries.slice(consumed)) {
        if (rows.length >= query.limit) break;
        consumed++;
        // One logical article appears once: only its current version is a row.
        if (category === "article" ? !e.article?.current : e.article !== undefined) continue;
        const approval = approvalOf(e);
        if (f.approval && approval !== f.approval) continue;
        if (text) {
          const hay = `${e.title ?? ""}\n${e.subtitle ?? ""}\n${e.excerpt ?? ""}`.toLowerCase();
          if (!hay.includes(text)) continue;
        }
        const r = await content.lookup(e.path);
        if (!r) {
          limitations.push("Some saved drafts could not be found at their recorded path.");
          continue;
        }
        rows.push({
          id: e.article ? e.article.id : e.path,
          summary: e.title ?? e.path,
          artifact: ref(r),
          category,
          approval,
          publicationId: e.publicationId,
          postId: e.postId,
          ...(e.subtitle ? { subtitle: e.subtitle } : {}),
          ...(e.excerpt ? { excerpt: e.excerpt } : {}),
          ...(e.draftedAt ? { draftedAt: e.draftedAt } : {}),
          ...(e.article ? { article: { id: e.article.id, version: e.article.version } } : {}),
          ...(e.limitation ? { limitations: [e.limitation] } : {}),
        });
      }
      const more = consumed < page.entries.length;
      const next = more
        ? encode({ k: category, ...(cursor?.after ? { after: cursor.after } : {}), skip: consumed })
        : page.next
          ? encode({ k: category, after: page.next, skip: 0 })
          : undefined;
      return { rows, ...(next ? { next } : {}), limitations: [...new Set(limitations)] };
    },
  };
}
