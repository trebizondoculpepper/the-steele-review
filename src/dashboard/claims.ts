import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import { parseThemeProposalResult } from "../analysis/theme-proposals.js";
import { CollectionRecordSchema } from "../collection/collection-store.js";
import { sourceVersionFor } from "../content/fulltext-document.js";

/**
 * Saved claim proposals for the dashboard (#494). Read-only, through the
 * artifact controller, resumable by cursor with a bound per request.
 *
 * Accepted claims, refinement candidates and rejected diagnostics stay
 * distinct; nothing here is a truth or research verdict. Each row is one
 * occurrence (a quotation in one post revision); repeated occurrences of the
 * same normalised claim keep their own rows and share `claimRecordId`, never
 * merged by display text. Theme links are resolved only through the exact
 * theme result the extraction pinned.
 */

export const CLAIM_RESULT_SCAN = 200;
export const CLAIM_PAGE = 25;
const LIST_PAGE = 50;
const RESULT_PATH = /^claim-extractions\/([^/]+)\/([^/]+)\/[^/]+\.json$/;

/**
 * `legacy`: claims in schema-version-1 extractions, which predate the current
 * acceptance checks; shown as such, never certified as accepted.
 */
export type ClaimCategory = "accepted" | "legacy" | "candidate" | "rejected";
export interface SourceArtifact {
  repository: string;
  commit: string;
  path: string;
  hash: string;
}

export interface ClaimRow {
  result: string;
  category: ClaimCategory;
  /** Position within its category in the saved extraction (link identity). */
  index: number;
  publicationId: string;
  postId: string;
  sourceVersion: string;
  statement?: string;
  passage?: string;
  span?: { start: number; end: number };
  speaker?: { kind: string; name?: string };
  sourcePublishedAt?: string;
  kind?: string;
  claimRecordId?: string;
  occurrenceId?: string;
  /** Recovered by a non-exact formatting rule rather than verbatim (#202). */
  quoteRecovered?: boolean;
  reasons?: string[];
  rejectionReason?: string;
  themes: { id: string; title?: string }[];
  /** commit:path of the theme result the theme ids belong to. */
  themeResult?: string;
  themeResultPath?: string;
  /** Exact archived source revision the extraction used (from its pinned theme result). */
  sourceArtifact?: SourceArtifact;
  modelVersion?: string;
  promptVersion?: string;
  extractedAt?: string;
}

export interface ClaimFilter {
  query?: string;
  post?: string;
  theme?: string;
  category?: ClaimCategory;
}

export interface ClaimListing {
  state: "ok" | "unavailable";
  rows: ClaimRow[];
  next?: string;
  partial: boolean;
  unreadable: number;
}

/** One saved claim occurrence for an article page (#497). */
export interface ArticleClaimLink {
  result: string;
  category: ClaimCategory;
  /** Position within its category in the saved extraction (link identity). */
  index: number;
  statement?: string;
  kind?: string;
  claimRecordId?: string;
  occurrenceId?: string;
  reasons?: string[];
  rejectionReason?: string;
}

export interface ArticleClaims {
  state: "ok" | "not-analysed" | "partial" | "unavailable";
  accepted: ArticleClaimLink[];
  /** Schema-version-1 claims: readable, never certified as accepted. */
  legacy: ArticleClaimLink[];
  candidates: ArticleClaimLink[];
  rejected: ArticleClaimLink[];
}

export interface ClaimsPort {
  list(filter: ClaimFilter & { after?: string }): Promise<ClaimListing>;
  detail(result: string, category: ClaimCategory, index: number): Promise<ClaimRow | undefined>;
  /**
   * The archived source text at the claim's exact revision, verified against
   * its recorded hash and source version; undefined when it cannot be proved.
   */
  sourceText(row: ClaimRow): Promise<string | undefined>;
  /** Saved claim occurrences for exactly this post revision; never another. */
  forPost(
    post: { publicationId: string; postId: string },
    sourceVersion: string,
  ): Promise<ArticleClaims>;
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read" | "lookupAt">;
type Archive = Pick<GitArtifactStore, "lookupAt">;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function savedClaims(content: Store, archive?: Archive): ClaimsPort {
  type Pinned = { titles: Map<string, string>; source?: SourceArtifact };
  const pinnedThemes = new Map<string, Pinned>();
  const titlesFor = async (
    pinned?: string,
  ): Promise<{ path?: string; titles: Map<string, string>; source?: SourceArtifact }> => {
    if (!pinned) return { titles: new Map() };
    const at = pinned.indexOf(":");
    const path = pinned.slice(at + 1);
    if (!pinnedThemes.has(pinned)) {
      const entry: Pinned = { titles: new Map() };
      try {
        const found = await content.lookupAt(pinned.slice(0, at), path);
        if (found) {
          const result = parseThemeProposalResult(JSON.parse(found.content));
          for (const p of result.proposals) entry.titles.set(p.id, p.title);
          // The exact archived source revision this analysis was made from.
          entry.source = result.artifact;
        }
      } catch {
        // titles stay unknown; ids are still shown
      }
      pinnedThemes.set(pinned, entry);
    }
    const entry = pinnedThemes.get(pinned)!;
    return { path, titles: entry.titles, ...(entry.source ? { source: entry.source } : {}) };
  };

  const readResult = async (path: string): Promise<ClaimRow[] | undefined> => {
    if (!RESULT_PATH.test(path)) return undefined;
    try {
      const ref = await content.lookup(path);
      if (!ref) return undefined;
      const rec = ClaimExtractionRecordSchema.parse(JSON.parse(await content.read(ref)));
      const { path: themePath, titles, source } = await titlesFor(rec.themeResult);
      const base = {
        result: path,
        publicationId: rec.post.publicationId,
        postId: rec.post.postId,
        sourceVersion: rec.sourceVersion,
        ...(rec.themeResult ? { themeResult: rec.themeResult } : {}),
        ...(themePath ? { themeResultPath: themePath } : {}),
        ...(source ? { sourceArtifact: source } : {}),
        ...(rec.extraction
          ? {
              modelVersion: str((rec.extraction as Record<string, unknown>).modelVersion),
              promptVersion: str((rec.extraction as Record<string, unknown>).promptVersion),
              extractedAt: str((rec.extraction as Record<string, unknown>).extractedAt),
            }
          : {}),
      };
      const themes = (ids: string[]) =>
        ids.map((id) => ({ id, ...(titles.has(id) ? { title: titles.get(id)! } : {}) }));
      const occurrence = (o: unknown) => {
        const v = (o ?? {}) as Record<string, unknown>;
        const span = v.span as { start?: unknown; end?: unknown } | undefined;
        const speaker = v.speaker as { kind?: unknown; name?: unknown } | undefined;
        return {
          ...(str(v.passage) ? { passage: str(v.passage) } : {}),
          ...(span && typeof span.start === "number" && typeof span.end === "number"
            ? { span: { start: span.start, end: span.end } }
            : {}),
          ...(speaker && typeof speaker.kind === "string"
            ? {
                speaker: {
                  kind: speaker.kind,
                  ...(str(speaker.name) ? { name: str(speaker.name)! } : {}),
                },
              }
            : {}),
          ...(str(v.sourcePublishedAt) ? { sourcePublishedAt: str(v.sourcePublishedAt) } : {}),
          ...(str(v.occurrenceId) ? { occurrenceId: str(v.occurrenceId) } : {}),
        };
      };
      const rows: ClaimRow[] = [];
      rec.claims.forEach((c, index) =>
        rows.push({
          ...base,
          category: rec.schemaVersion === 1 ? "legacy" : "accepted",
          index,
          ...(str((c.claim as Record<string, unknown> | undefined)?.statement)
            ? { statement: str((c.claim as Record<string, unknown>).statement) }
            : {}),
          ...occurrence(c.occurrence),
          kind: c.kind,
          ...(c.claimRecordId ? { claimRecordId: c.claimRecordId } : {}),
          ...(c.match ? { quoteRecovered: true } : {}),
          themes: themes(c.themeIds),
        }),
      );
      (rec.candidates ?? []).forEach((c, index) =>
        rows.push({
          ...base,
          category: "candidate",
          index,
          ...(str((c.claim as Record<string, unknown> | undefined)?.statement)
            ? { statement: str((c.claim as Record<string, unknown>).statement) }
            : {}),
          ...occurrence(c.occurrence),
          kind: c.kind,
          reasons: c.reasons,
          ...(c.match ? { quoteRecovered: true } : {}),
          themes: themes(c.themeIds),
        }),
      );
      rec.rejected.forEach((r, index) => {
        // Diagnostic text lives under the snapshot's allowlisted `fields`;
        // older records may carry it flat.
        const raw = (r.candidate ?? {}) as Record<string, unknown>;
        const snap = { ...raw, ...((raw.fields as Record<string, unknown> | undefined) ?? {}) };
        rows.push({
          ...base,
          category: "rejected",
          index,
          ...(str(snap.statement) ? { statement: str(snap.statement) } : {}),
          ...(str(snap.passage) ? { passage: str(snap.passage) } : {}),
          rejectionReason: r.reason,
          themes: [],
        });
      });
      return rows;
    } catch {
      return undefined;
    }
  };

  const matches = (f: ClaimFilter) => (r: ClaimRow) => {
    if (f.category && r.category !== f.category) return false;
    if (f.post && r.postId !== f.post) return false;
    if (f.theme && !r.themes.some((t) => t.id === f.theme)) return false;
    const q = f.query?.trim().toLowerCase();
    return (
      !q ||
      (r.statement ?? "").toLowerCase().includes(q) ||
      (r.passage ?? "").toLowerCase().includes(q)
    );
  };

  return {
    async forPost(post, sourceVersion) {
      const prefix = `claim-extractions/${post.publicationId}/${post.postId}`;
      let paths: string[];
      try {
        paths = await content.list(prefix, LIST_PAGE);
      } catch {
        return { state: "unavailable", accepted: [], legacy: [], candidates: [], rejected: [] };
      }
      const partial = paths.length >= LIST_PAGE;
      const empty = (): Omit<ArticleClaims, "state"> => ({
        accepted: [],
        legacy: [],
        candidates: [],
        rejected: [],
      });
      const result = empty();
      let matched = false;
      let unreadable = 0;
      for (const path of paths) {
        if (!RESULT_PATH.test(path)) continue;
        let record;
        try {
          const ref = await content.lookup(path);
          if (!ref) continue;
          record = ClaimExtractionRecordSchema.parse(JSON.parse(await content.read(ref)));
        } catch {
          unreadable++;
          continue;
        }
        // The saved record's own version is authoritative: a newer rerun must
        // not be substituted for the selected revision.
        if (record.sourceVersion !== sourceVersion) continue;
        matched = true;
        const link = (
          category: ClaimCategory,
          index: number,
          item: {
            claim: unknown;
            occurrence: unknown;
            kind: string;
            claimRecordId?: string;
            reasons?: string[];
          },
        ): ArticleClaimLink => {
          const statement = str((item.claim as { statement?: unknown } | undefined)?.statement);
          const occurrenceId = str(
            (item.occurrence as { occurrenceId?: unknown } | undefined)?.occurrenceId,
          );
          return {
            result: path,
            category,
            index,
            ...(statement ? { statement } : {}),
            ...(item.kind ? { kind: item.kind } : {}),
            ...("claimRecordId" in item && item.claimRecordId
              ? { claimRecordId: item.claimRecordId }
              : {}),
            ...(occurrenceId ? { occurrenceId } : {}),
            ...("reasons" in item && item.reasons ? { reasons: item.reasons } : {}),
          };
        };
        if (record.schemaVersion === 1) {
          result.legacy.push(
            ...record.claims.map((c, i) => link("legacy", i, c)),
          );
        } else {
          result.accepted.push(...record.claims.map((c, i) => link("accepted", i, c)));
          result.candidates.push(
            ...(record.candidates ?? []).map((c, i) => link("candidate", i, c)),
          );
        }
        result.rejected.push(
          ...record.rejected.map((r, i) => ({
            result: path,
            category: "rejected" as const,
            index: i,
            rejectionReason: r.reason,
          })),
        );
      }
      if (unreadable > 0) return { ...result, state: "partial" };
      if (!matched) return { ...empty(), state: partial ? "partial" : "not-analysed" };
      return { ...result, state: partial ? "partial" : "ok" };
    },

    async list(filter) {
      const keep = matches(filter);
      const rows: ClaimRow[] = [];
      let unreadable = 0;
      let scanned = 0;
      let cursor = filter.after;
      let exhausted = false;
      while (rows.length < CLAIM_PAGE && scanned < CLAIM_RESULT_SCAN) {
        let paths: string[];
        try {
          paths = await content.list("claim-extractions", LIST_PAGE, cursor);
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
          else rows.push(...r.filter(keep));
          if (rows.length >= CLAIM_PAGE || scanned >= CLAIM_RESULT_SCAN) break;
        }
        if (paths.length < LIST_PAGE && cursor === paths.at(-1)) {
          exhausted = true;
          break;
        }
      }
      return {
        state: "ok",
        rows,
        ...(exhausted ? {} : cursor ? { next: cursor } : {}),
        partial: !exhausted && rows.length < CLAIM_PAGE,
        unreadable,
      };
    },
    async detail(result, category, index) {
      const rows = await readResult(result);
      return rows?.find((r) => r.category === category && r.index === index);
    },
    async sourceText(row) {
      const a = row.sourceArtifact;
      if (!archive || !a) return undefined;
      try {
        const found = await archive.lookupAt(a.commit, a.path);
        if (!found || `sha256:${found.ref.sha256}` !== a.hash) return undefined;
        const text = CollectionRecordSchema.parse(JSON.parse(found.content)).text;
        // The revision the quotation came from, not merely the same post.
        return sourceVersionFor(text) === row.sourceVersion ? text : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
