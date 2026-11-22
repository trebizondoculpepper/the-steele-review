import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { CatalogueSchema, CATALOGUE_PATH } from "../analysis/theme-catalogue.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import { parseThemeProposalResult } from "../analysis/theme-proposals.js";
import { ThemeStore, type CanonicalTheme as CanonicalThemeRecord } from "../research/theme-store.js";
import { themeCoverage, type ResearchState, type ThemeCoverage } from "../research/theme-coverage.js";
import { dossierPath } from "../research/dossier.js";
import {
  ThemeMappingSchema,
  ThemeMappingSupersessionSchema,
  normaliseMappingKey,
} from "../research/theme-mappings.js";

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
/** Canonical catalogue page and bounded per-request scan (#517). */
export const CANONICAL_PAGE = 25;
export const CANONICAL_SCAN = 500;
const CANONICAL_LIST_PAGE = 100;
/** Bound on librarian mappings examined for one theme detail. */
const MAPPING_SCAN = 500;
const MAPPING_LIST_PAGE = 100;

/**
 * Saved supersession graph, built once for one detail page. Redirects are
 * followed by their `from` identity (never collapsed to one event per
 * proposal), newest event per source wins by parsed instant, and the result
 * reports whether the scan was complete. This mirrors the catalogue's
 * cycle-safe resolution so the browser cannot assign a proposal to a theme the
 * librarian's own lookup would not.
 */
interface SupersessionGraph {
  bySource: Map<string, { to: string; at: number; decidedAt: string; path: string }[]>;
  complete: boolean;
}

/** Scope identifiers are normalised exactly as the catalogue's paths are. */
const scopeKey = (scope?: string) => (scope === undefined ? "" : normaliseMappingKey(scope));

async function supersessionGraph(content: Store): Promise<SupersessionGraph> {
  const bySource = new Map<
    string,
    { to: string; at: number; decidedAt: string; path: string }[]
  >();
  let complete = true;
  let after: string | undefined;
  let scanned = 0;
  for (let page = 0; page < 10; page++) {
    let paths: string[];
    try {
      paths = await content.list(
        "librarian/theme-mappings/supersessions",
        MAPPING_LIST_PAGE,
        after,
      );
    } catch {
      complete = false;
      break;
    }
    if (paths.length === 0) break;
    for (const path of paths) {
      after = path;
      if (scanned++ >= MAPPING_SCAN) return { bySource, complete: false };
      try {
        const ref = await content.lookup(path);
        if (!ref) {
          complete = false;
          continue;
        }
        const parsed = ThemeMappingSupersessionSchema.safeParse(JSON.parse(await content.read(ref)));
        if (!parsed.success) continue; // malformed record: skipped, not guessed
        const s = parsed.data;
        const key = `${s.key}\u0000${scopeKey(s.scope)}\u0000${s.from}`;
        const list = bySource.get(key) ?? [];
        list.push({ to: s.to, at: Date.parse(s.decidedAt), decidedAt: s.decidedAt, path });
        bySource.set(key, list);
      } catch {
        complete = false;
      }
    }
    if (paths.length < MAPPING_LIST_PAGE) break;
  }
  return { bySource, complete };
}

/** Cycle-safe redirect chain for one mapping, newest-event-per-source. */
function resolveCanonical(
  mapping: { key: string; scope?: string; canonicalThemeId: string },
  graph: SupersessionGraph,
): string {
  let current = mapping.canonicalThemeId;
  const seen = new Set([current]);
  for (let hops = 0; hops < 20; hops++) {
    const events = graph.bySource.get(
      `${mapping.key}\u0000${scopeKey(mapping.scope)}\u0000${current}`,
    );
    if (!events || events.length === 0) return current;
    // Match the catalogue exactly: ascending by (instant, decidedAt, path),
    // then take the last, which is equivalent to descending here.
    const newest = [...events].sort((a, b) => {
      if (a.at !== b.at) return b.at - a.at;
      if (a.decidedAt !== b.decidedAt) return b.decidedAt.localeCompare(a.decidedAt);
      return b.path.localeCompare(a.path);
    })[0]!;
    if (seen.has(newest.to)) return current;
    seen.add(newest.to);
    current = newest.to;
  }
  return current;
}

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

/** One canonical theme row with its actual research coverage (#517). */
export interface CanonicalThemeRow {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  state: ResearchState;
  /** Present only when the theme has a saved dossier. */
  dossier?: { commit: string; hash: string; path: string; covered: number; gaps: number; citations: number };
}

export interface CanonicalListing {
  state: "ok" | "unavailable";
  rows: CanonicalThemeRow[];
  next?: string;
  /** True when the bounded scan was exhausted before the catalogue was. */
  partial: boolean;
  unreadable: number;
}

export interface MappedProposal {
  proposal: string;
  description?: string;
  scope?: string;
  decidedAt: string;
  decidedBy: { publicationId: string; postId: string };
  rationale: string;
}

export interface CanonicalDetail {
  theme: CanonicalThemeRecord;
  coverage: ThemeCoverage;
  /** Proposals the librarian mapped to this theme's current identity. */
  proposals: MappedProposal[];
  /** True when the mapping scan bound was reached. */
  proposalsPartial: boolean;
}

export interface ThemesPort {
  list(options: { query?: string; after?: string }): Promise<ThemeListing>;
  detail(result: string, id: string): Promise<ThemeDetail | undefined>;
  catalogue(): Promise<{ state: "ok" | "unavailable" | "none"; themes: CanonicalTheme[] }>;
  /** Librarian-established canonical themes, researched or not (#517). */
  canonical(filter: {
    query?: string;
    coverage?: ResearchState;
    after?: string;
  }): Promise<CanonicalListing>;
  /** One canonical theme with real coverage and mapped proposals. */
  canonicalDetail(id: string): Promise<CanonicalDetail | undefined>;
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

    async canonical(filter) {
      const q = filter.query?.trim().toLowerCase();
      const store = new ThemeStore(content as never);
      const rows: CanonicalThemeRow[] = [];
      let unreadable = 0;
      let partial = false;
      let cursor = filter.after;
      let exhausted = false;
      let scanned = 0;
      // Bounded, resumable scan over the canonical prefix: the caller's cursor
      // reaches the entire catalogue without loading it in one request.
      while (rows.length < CANONICAL_PAGE && scanned < CANONICAL_SCAN) {
        let paths: string[];
        try {
          paths = await store.listPage(CANONICAL_LIST_PAGE, cursor);
        } catch {
          return { state: "unavailable", rows: [], partial: false, unreadable: 0 };
        }
        if (paths.length === 0) {
          exhausted = true;
          break;
        }
        for (const path of paths) {
          cursor = path;
          scanned++;
          const id = /^canonical-themes\/([^/]+)\.json$/.exec(path)?.[1];
          if (!id) continue;
          const coverage = await themeCoverage(content as never, id).catch(() => undefined);
          if (!coverage) {
            unreadable++;
            continue;
          }
          const { theme } = coverage;
          const matches =
            !q ||
            theme.title.toLowerCase().includes(q) ||
            (theme.description ?? "").toLowerCase().includes(q);
          if (!matches) continue;
          if (filter.coverage && coverage.state !== filter.coverage) continue;
          rows.push({
            id: theme.id,
            title: theme.title,
            ...(theme.description ? { description: theme.description } : {}),
            createdAt: theme.createdAt,
            state: coverage.state,
            ...(coverage.dossier
              ? {
                  dossier: {
                    commit: coverage.dossier.commit,
                    hash: coverage.dossier.hash,
                    path: dossierPath(theme.id),
                    covered: coverage.dossier.covered,
                    gaps: coverage.dossier.gaps,
                    citations: coverage.dossier.citations,
                  },
                }
              : {}),
          });
          if (rows.length >= CANONICAL_PAGE || scanned >= CANONICAL_SCAN) break;
        }
      }
      if (!exhausted && (scanned >= CANONICAL_SCAN || cursor !== undefined)) {
        // Either the scan bound was hit or the page stopped with more to read.
        partial = scanned >= CANONICAL_SCAN;
      }
      return {
        state: "ok",
        rows,
        ...(exhausted ? {} : { next: cursor }),
        partial,
        unreadable,
      };
    },

    async canonicalDetail(id) {
      const coverage = await themeCoverage(content as never, id).catch(() => undefined);
      if (!coverage) return undefined;
      const graph = await supersessionGraph(content).catch(() => ({
        bySource: new Map(),
        complete: false,
      }));
      const proposals: MappedProposal[] = [];
      let proposalsPartial = false;
      let after: string | undefined;
      let scanned = 0;
      for (let page = 0; page < 10; page++) {
        let paths: string[];
        try {
          paths = await content.list("librarian/theme-mappings", MAPPING_LIST_PAGE, after);
        } catch {
          proposalsPartial = true;
          break;
        }
        if (paths.length === 0) break;
        for (const path of paths) {
          after = path;
          if (!/^librarian\/theme-mappings\/(?:global|scope-[^/]+)\/[^/]+\.json$/.test(path)) continue;
          scanned++;
          if (scanned >= MAPPING_SCAN) {
            proposalsPartial = true;
            break;
          }
          try {
            const ref = await content.lookup(path);
            if (!ref) continue;
            const parsed = ThemeMappingSchema.safeParse(JSON.parse(await content.read(ref)));
            if (!parsed.success) continue;
            const mapping = parsed.data;
            const target = resolveCanonical(mapping, graph);
            if (target !== coverage.theme.id) continue;
            proposals.push({
              proposal: mapping.proposal,
              ...(mapping.description ? { description: mapping.description } : {}),
              ...(mapping.scope ? { scope: mapping.scope } : {}),
              decidedAt: mapping.decidedAt,
              decidedBy: mapping.decidedBy,
              rationale: mapping.rationale,
            });
          } catch {
            // An unreadable mapping is omitted, never guessed, and its absence
            // is not presented as authoritative.
            proposalsPartial = true;
          }
        }
        if (proposalsPartial || paths.length < MAPPING_LIST_PAGE) break;
      }
      proposals.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
      return {
        theme: coverage.theme,
        coverage,
        proposals,
        proposalsPartial: proposalsPartial || !graph.complete,
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
