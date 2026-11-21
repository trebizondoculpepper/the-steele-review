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
/** Artifact paths requested per listing call while scanning. */
const THEME_LIST_PAGE = 50;
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

/** Saved theme proposals for one exact article revision (#496). */
export interface ArticleThemeLink {
  /** Saved extraction path; with `id`, the stable detail link identity. */
  result: string;
  id: string;
  title: string;
  description?: string;
  sourceVersion: string;
}

export interface ArticleThemes {
  state: "ok" | "not-analysed" | "partial" | "unavailable";
  themes: ArticleThemeLink[];
}

export interface ThemeListing {
  state: "ok" | "unavailable";
  rows: ThemeRow[];
  /**
   * Continuation cursor: the last saved extraction scanned. Absent when every
   * extraction after the previous cursor has been scanned.
   */
  next?: string;
  /** This request stopped at its scan bound before finding a full page. */
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
  list(options: { query?: string; after?: string }): Promise<ThemeListing>;
  detail(result: string, id: string): Promise<ThemeDetail | undefined>;
  catalogue(): Promise<{ state: "ok" | "unavailable" | "none"; themes: CanonicalTheme[] }>;
  /** Proposals saved for exactly this post revision; never a newer result. */
  forPost(
    post: { publicationId: string; postId: string },
    sourceVersion: string,
  ): Promise<ArticleThemes>;
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;

export function savedThemes(
  content: Store,
  options: { scanLimit?: number } = {},
): ThemesPort {
  const scanLimit = options.scanLimit ?? THEME_RESULT_SCAN;
  const readResultState = async (
    path: string,
  ): Promise<{ sourceVersion: string; rows: ThemeRow[] } | "unreadable" | undefined> => {
    const m = RESULT_PATH.exec(path);
    if (!m) return undefined;
    try {
      const ref = await content.lookup(path);
      if (!ref) return undefined;
      const r = parseThemeProposalResult(JSON.parse(await content.read(ref)));
      return {
        sourceVersion: r.sourceVersion,
        rows: r.proposals.map((p) => ({
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
        })),
      };
    } catch {
      return "unreadable";
    }
  };
  const readResult = async (path: string): Promise<ThemeRow[] | undefined> => {
    const state = await readResultState(path);
    if (state === undefined || state === "unreadable") return undefined;
    return state.rows;
  };
  return {
    async list({ query, after }) {
      // Bounded per request, resumable by cursor: every saved extraction is
      // eventually reachable without an unbounded scan (#493).
      const q = query?.trim().toLowerCase();
      const matches = (r: ThemeRow) =>
        !q || r.title.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q);
      const rows: ThemeRow[] = [];
      let unreadable = 0;
      let scanned = 0;
      let cursor = after;
      let exhausted = false;
      while (rows.length < THEME_PAGE && scanned < scanLimit) {
        let paths: string[];
        try {
          paths = await content.list("theme-proposals", THEME_LIST_PAGE, cursor);
        } catch {
          return { state: "unavailable", rows: [], partial: false, unreadable: 0 };
        }
        if (paths.length === 0) {
          exhausted = true;
          break;
        }
        for (const path of paths) {
          cursor = path;
          if (!RESULT_PATH.test(path)) continue;
          scanned++;
          const r = await readResult(path);
          if (!r) unreadable++;
          else rows.push(...r.filter(matches));
          if (rows.length >= THEME_PAGE || scanned >= scanLimit) break;
        }
        if (paths.length < THEME_LIST_PAGE && cursor === paths.at(-1)) {
          exhausted = true;
          break;
        }
      }
      return {
        state: "ok",
        rows,
        ...(exhausted ? {} : cursor ? { next: cursor } : {}),
        partial: !exhausted && rows.length < THEME_PAGE,
        unreadable,
      };
    },

    async forPost(post, sourceVersion) {
      const prefix = `theme-proposals/${post.publicationId}/${post.postId}`;
      let paths: string[];
      try {
        paths = await content.list(prefix, THEME_LIST_PAGE);
      } catch {
        return { state: "unavailable", themes: [] };
      }
      // A bounded per-post scan: a post has few saved analyses, and hitting the
      // bound is reported as partial rather than silently treated as complete.
      const partial = paths.length >= THEME_LIST_PAGE;
      const themes: ArticleThemeLink[] = [];
      let matchedResult = false;
      let unreadable = 0;
      for (const path of paths) {
        if (!RESULT_PATH.test(path)) continue;
        const state = await readResultState(path);
        if (state === undefined) continue;
        if (state === "unreadable") {
          unreadable++;
          continue;
        }
        // The source version is checked on the saved result itself, so a valid
        // extraction with no proposals is still "analysed".
        if (state.sourceVersion !== sourceVersion) continue;
        matchedResult = true;
        themes.push(
          ...state.rows.map((r) => ({
            result: r.result,
            id: r.id,
            title: r.title,
            ...(r.description ? { description: r.description } : {}),
            sourceVersion: r.sourceVersion,
          })),
        );
      }
      // An unreadable saved result is not evidence that nothing was analysed.
      if (unreadable > 0) return { state: "partial", themes };
      if (!matchedResult) return { state: partial ? "partial" : "not-analysed", themes: [] };
      return { state: partial ? "partial" : "ok", themes };
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
