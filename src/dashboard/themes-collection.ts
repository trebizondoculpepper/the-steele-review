import { z } from "zod";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { themePath } from "../research/theme-store.js";
import {
  ThemeMappingSchema,
  proposalMappingKey,
  themeMappingPath,
} from "../research/theme-mappings.js";
import type { CollectionAdapter, CollectionPage, CollectionRow } from "./collection-query.js";
import type { ThemesPort } from "./themes.js";

/**
 * Canonical themes and extraction proposals through the shared collection
 * contract (#618, on #617).
 *
 * The two stay distinct identities: a required `category` filter selects one
 * or the other, never a mixed list. Canonical coverage comes from the typed
 * themes reader, which reads actual dossier evidence; proposal mapping status
 * comes from the exact saved mapping file for the proposal's wording. Nothing
 * here recomputes similarity, writes the corpus or calls a model. Every row
 * carries the exact artifact it was read from.
 */

type Store = Pick<GitArtifactStore, "lookup" | "read">;

export type ThemeCategory = "canonical" | "proposal";
export type ProposalMapping = "mapped" | "unresolved" | "unmapped";

export type ThemeBrowseRow = CollectionRow & {
  category: ThemeCategory;
  description?: string;
  /** Canonical: research coverage from actual dossier evidence. */
  coverage?: "unresearched" | "partially-researched" | "researched";
  /** Proposal: the saved mapping decision for this wording, if any. */
  mapping?: ProposalMapping;
  mappedTheme?: string;
  /** Proposal: its source post and saved extraction. */
  post?: { publicationId: string; postId: string };
  result?: string;
};

const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

/** Cursor: the reader's own continuation plus rows already shown from that page. */
const Cursor = z
  .object({
    c: z.enum(["canonical", "proposal"]),
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

export function themesCollection(
  themes: ThemesPort,
  content: Store,
): CollectionAdapter & {
  search(
    query: Parameters<CollectionAdapter["search"]>[0],
  ): Promise<CollectionPage & { rows: ThemeBrowseRow[] }>;
} {
  const mappingOf = async (
    title: string,
    description?: string,
  ): Promise<{ status: ProposalMapping; theme?: string }> => {
    const r = await content.lookup(
      themeMappingPath({ key: proposalMappingKey(title, description) }),
    );
    if (!r) return { status: "unmapped" };
    const parsed = ThemeMappingSchema.safeParse(JSON.parse(await content.read(r)));
    if (!parsed.success) return { status: "unmapped" };
    return parsed.data.status === "unresolved"
      ? { status: "unresolved" }
      : { status: "mapped", theme: parsed.data.canonicalThemeId };
  };

  return {
    name: "themes",
    filters: {
      category: {
        schema: z.enum(["canonical", "proposal"]),
        description: "Canonical themes or extraction proposals (never mixed)",
      },
      coverage: {
        schema: z.enum(["unresearched", "partially-researched", "researched"]),
        description: "Canonical only: research coverage from actual dossier evidence",
      },
      mapping: {
        schema: z.enum(["mapped", "unresolved", "unmapped"]),
        description: "Proposal only: the saved mapping decision for its wording",
      },
    },
    sorts: ["stored"],
    async search(query) {
      const f = query.filters as {
        category?: ThemeCategory;
        coverage?: ThemeBrowseRow["coverage"];
        mapping?: ProposalMapping;
      };
      const category: ThemeCategory = f.category ?? "canonical";
      const limitations: string[] = [];
      if (category === "proposal" && f.coverage)
        limitations.push(
          "Coverage applies to canonical themes only; it was not applied to proposals.",
        );
      if (category === "canonical" && f.mapping)
        limitations.push(
          "Mapping status applies to proposals only; it was not applied to canonical themes.",
        );
      let cursor = query.cursor ? decode(query.cursor) : undefined;
      if (query.cursor && (!cursor || cursor.c !== category)) {
        limitations.push("The page link was not valid for this list; showing the first page.");
        cursor = undefined;
      }
      const skip = cursor?.skip ?? 0;
      const after = cursor?.after;
      const text = query.text;

      if (category === "canonical") {
        const page = await themes.canonical({
          ...(text ? { query: text } : {}),
          ...(f.coverage ? { coverage: f.coverage } : {}),
          ...(after ? { after } : {}),
        });
        if (page.state === "unavailable") throw new Error("canonical themes unavailable");
        if (page.partial)
          limitations.push("This page reached its scan bound; continue to see more.");
        if (page.unreadable)
          limitations.push(`${page.unreadable} canonical theme(s) could not be read.`);
        const slice = page.rows.slice(skip, skip + query.limit);
        const rows: ThemeBrowseRow[] = [];
        for (const t of slice) {
          const r = await content.lookup(themePath(t.id));
          if (!r) continue;
          rows.push({
            id: t.id,
            summary: t.title,
            artifact: ref(r),
            category,
            ...(t.description ? { description: t.description } : {}),
            coverage: t.state,
          });
        }
        const more = skip + slice.length < page.rows.length;
        const next = more
          ? encode({ c: category, ...(after ? { after } : {}), skip: skip + slice.length })
          : page.next
            ? encode({ c: category, after: page.next, skip: 0 })
            : undefined;
        return { rows, ...(next ? { next } : {}), limitations };
      }

      // Proposals: the reader pages saved extractions; mapping status is read
      // from each proposal's exact mapping file.
      const page = await themes.list({
        ...(text ? { query: text } : {}),
        ...(after ? { after } : {}),
      });
      if (page.state === "unavailable") throw new Error("theme proposals unavailable");
      if (page.partial) limitations.push("This page reached its scan bound; continue to see more.");
      if (page.unreadable)
        limitations.push(`${page.unreadable} saved extraction(s) could not be read.`);
      const rows: ThemeBrowseRow[] = [];
      let consumed = skip;
      for (const p of page.rows.slice(skip)) {
        if (rows.length >= query.limit) break;
        consumed++;
        const m = await mappingOf(p.title, p.description);
        if (f.mapping && m.status !== f.mapping) continue;
        const r = await content.lookup(p.result);
        if (!r) continue;
        rows.push({
          id: `${p.result}#${p.id}`,
          summary: p.title,
          artifact: ref(r),
          category,
          ...(p.description ? { description: p.description } : {}),
          mapping: m.status,
          ...(m.theme ? { mappedTheme: m.theme } : {}),
          post: { publicationId: p.publicationId, postId: p.postId },
          result: p.result,
        });
      }
      const more = consumed < page.rows.length;
      const next = more
        ? encode({ c: category, ...(after ? { after } : {}), skip: consumed })
        : page.next
          ? encode({ c: category, after: page.next, skip: 0 })
          : undefined;
      return { rows, ...(next ? { next } : {}), limitations };
    },
  };
}
