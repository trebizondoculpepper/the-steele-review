import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { CatalogueSchema, CATALOGUE_PATH } from "../analysis/theme-catalogue.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import { parseThemeProposalResult } from "../analysis/theme-proposals.js";

/**
 * Saved themes for the dashboard (#493). Read-only, through the artifact
 * controller, bounded per request.
 *
 * Extractor proposals (one saved result per post revision) are kept distinct
 * from the librarian's canonical catalogue: two posts' similar labels stay
 * two proposals, never silently one theme. A scan that hits its bound says
 * so, and a failed read is "unavailable", not "no themes".
 */

export const THEME_RESULT_SCAN = 200;
export const THEME_PAGE = 25;
const RESULT_PATH = /^theme-proposals\/([^/]+)\/([^/]+)\/[^/]+\.json$/;

export interface ThemeRow {
  /** Saved extraction this proposal belongs to (stable link identity). */
  result: string;
  id: string;
  title: string;
  description?: string;
  publicationId: string;
  postId: string;
  sourceVersion: string;
  modelVersion: string;
  promptVersion: string;
  proposedAt: string;
  /** Rejected candidates retained in the same extraction. */
  rejectedInResult: number;
}

export interface ThemeListing {
  state: "ok" | "unavailable";
  rows: ThemeRow[];
  /** More matching rows exist beyond this page. */
  next?: number;
  /** The scan of saved extractions reached its bound: results may be incomplete. */
  partial: boolean;
  unreadable: number;
}

export interface ThemeDetail {
  row: ThemeRow;
  claims: { statement: string; claimRecordId?: string }[];
  claimsPartial: boolean;
}

export interface CanonicalTheme {
  id: string;
  name: string;
  definition: string;
  origin: string;
  aliases: string[];
}

export interface ThemesPort {
  list(options: { query?: string; offset?: number }): Promise<ThemeListing>;
  detail(result: string, id: string): Promise<ThemeDetail | undefined>;
  catalogue(): Promise<{ state: "ok" | "unavailable" | "none"; themes: CanonicalTheme[] }>;
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;

export function savedThemes(content: Store): ThemesPort {
  const readResult = async (path: string): Promise<ThemeRow[] | undefined> => {
    const m = RESULT_PATH.exec(path);
    if (!m) return undefined;
    try {
      const ref = await content.lookup(path);
      if (!ref) return undefined;
      const r = parseThemeProposalResult(JSON.parse(await content.read(ref)));
      return r.proposals.map((p) => ({
        result: path,
        id: p.id,
        title: p.title,
        ...(p.description ? { description: p.description } : {}),
        publicationId: r.post.publicationId,
        postId: r.post.postId,
        sourceVersion: r.sourceVersion,
        modelVersion: r.extraction.modelVersion,
        promptVersion: r.extraction.promptVersion,
        proposedAt: r.extraction.proposedAt,
        rejectedInResult: r.rejected.length,
      }));
    } catch {
      return undefined;
    }
  };

  return {
    async list({ query, offset = 0 }) {
      let paths: string[];
      try {
        paths = (await content.list("theme-proposals", THEME_RESULT_SCAN + 1)).filter((p) =>
          RESULT_PATH.test(p),
        );
      } catch {
        return { state: "unavailable", rows: [], partial: false, unreadable: 0 };
      }
      const partial = paths.length > THEME_RESULT_SCAN;
      const rows: ThemeRow[] = [];
      let unreadable = 0;
      for (const path of paths.slice(0, THEME_RESULT_SCAN)) {
        const r = await readResult(path);
        if (!r) unreadable++;
        else rows.push(...r);
      }
      const q = query?.trim().toLowerCase();
      const matching = q
        ? rows.filter(
            (r) =>
              r.title.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
          )
        : rows;
      // Stable order: by title, then post, then the saved extraction.
      matching.sort(
        (a, b) =>
          a.title.localeCompare(b.title) ||
          a.postId.localeCompare(b.postId) ||
          a.result.localeCompare(b.result),
      );
      const page = matching.slice(offset, offset + THEME_PAGE);
      return {
        state: "ok",
        rows: page,
        ...(offset + THEME_PAGE < matching.length ? { next: offset + THEME_PAGE } : {}),
        partial,
        unreadable,
      };
    },

    async detail(result, id) {
      const rows = await readResult(result);
      const row = rows?.find((r) => r.id === id);
      if (!row) return undefined;
      // Claims extracted against this exact saved theme result that link this proposal.
      const claims: ThemeDetail["claims"] = [];
      let claimsPartial = false;
      try {
        const themeRef = await content.lookup(result);
        const pinned = themeRef ? `${themeRef.commit}:${themeRef.path}` : undefined;
        const paths = await content.list(
          `claim-extractions/${row.publicationId}/${row.postId}`,
          50,
        );
        if (paths.length >= 50) claimsPartial = true;
        for (const path of paths) {
          try {
            const ref = await content.lookup(path);
            if (!ref) continue;
            const rec = ClaimExtractionRecordSchema.parse(JSON.parse(await content.read(ref)));
            if (rec.themeResult !== pinned) continue;
            for (const c of rec.claims) {
              if (!c.themeIds.includes(id)) continue;
              const statement = (c.claim as { statement?: unknown })?.statement;
              if (typeof statement !== "string") continue;
              claims.push({
                statement,
                ...(c.claimRecordId ? { claimRecordId: c.claimRecordId } : {}),
              });
            }
          } catch {
            claimsPartial = true;
          }
        }
      } catch {
        claimsPartial = true;
      }
      return { row, claims, claimsPartial };
    },

    async catalogue() {
      try {
        const ref = await content.lookup(CATALOGUE_PATH);
        if (!ref) return { state: "none", themes: [] };
        const c = CatalogueSchema.parse(JSON.parse(await content.read(ref)));
        return {
          state: "ok",
          themes: c.themes.map((t) => ({
            id: t.id,
            name: t.name,
            definition: t.definition,
            origin: t.origin,
            aliases: t.aliases,
          })),
        };
      } catch {
        return { state: "unavailable", themes: [] };
      }
    },
  };
}
