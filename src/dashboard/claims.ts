import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import { parseThemeProposalResult } from "../analysis/theme-proposals.js";

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

export type ClaimCategory = "accepted" | "candidate" | "rejected";

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

export interface ClaimsPort {
  list(filter: ClaimFilter & { after?: string }): Promise<ClaimListing>;
  detail(result: string, category: ClaimCategory, index: number): Promise<ClaimRow | undefined>;
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read" | "lookupAt">;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function savedClaims(content: Store): ClaimsPort {
  const themeTitles = new Map<string, Map<string, string>>();
  const titlesFor = async (
    pinned?: string,
  ): Promise<{ path?: string; titles: Map<string, string> }> => {
    if (!pinned) return { titles: new Map() };
    const at = pinned.indexOf(":");
    const path = pinned.slice(at + 1);
    if (!themeTitles.has(pinned)) {
      const titles = new Map<string, string>();
      try {
        const found = await content.lookupAt(pinned.slice(0, at), path);
        if (found) {
          for (const p of parseThemeProposalResult(JSON.parse(found.content)).proposals) {
            titles.set(p.id, p.title);
          }
        }
      } catch {
        // titles stay unknown; ids are still shown
      }
      themeTitles.set(pinned, titles);
    }
    return { path, titles: themeTitles.get(pinned)! };
  };

  const readResult = async (path: string): Promise<ClaimRow[] | undefined> => {
    if (!RESULT_PATH.test(path)) return undefined;
    try {
      const ref = await content.lookup(path);
      if (!ref) return undefined;
      const rec = ClaimExtractionRecordSchema.parse(JSON.parse(await content.read(ref)));
      const { path: themePath, titles } = await titlesFor(rec.themeResult);
      const base = {
        result: path,
        publicationId: rec.post.publicationId,
        postId: rec.post.postId,
        sourceVersion: rec.sourceVersion,
        ...(rec.themeResult ? { themeResult: rec.themeResult } : {}),
        ...(themePath ? { themeResultPath: themePath } : {}),
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
          category: "accepted",
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
        const snap = (r.candidate ?? {}) as Record<string, unknown>;
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
  };
}
