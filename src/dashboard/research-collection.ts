import { z } from "zod";
import type {
  CollectionAdapter,
  CollectionPage,
  CollectionRow,
} from "./collection-query.js";
import type { ResearchKind, ResearchPort, ResearchRow } from "./research.js";

/**
 * Research documents through the shared collection contract (#620).
 *
 * Adapter over the existing typed research reader: dossiers, imported reports
 * and generated job reports stay distinct, records keep their exact commit and
 * hash, and the list is bounded/resumable. No vendor query or model call is
 * made here; the reader already owns Git access.
 */

export const RESEARCH_BROWSE_SCAN = 500;

export type ResearchBrowseRow = CollectionRow & {
  kind: ResearchKind;
  subject?: string;
  date?: string;
};

const cursorOf = (sortKey: string, path: string) =>
  Buffer.from(JSON.stringify([sortKey, path])).toString("base64url");
function decodeCursor(cursor: string): [string, string] | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) && value.length === 2 && value.every((x) => typeof x === "string")
      ? (value as [string, string])
      : undefined;
  } catch {
    return undefined;
  }
}

const dossierTheme = (path: string) =>
  /^dossier\/([^/]+)\.md$/.exec(path)?.[1];

const ref = (row: ResearchRow) => ({
  repository: "content",
  commit: row.commit,
  path: row.path,
  hash: `sha256:${row.hash}`,
});

export function researchCollection(research: ResearchPort): CollectionAdapter & {
  search(
    query: Parameters<CollectionAdapter["search"]>[0],
  ): Promise<CollectionPage & { rows: ResearchBrowseRow[] }>;
} {
  return {
    name: "research-documents",
    filters: {
      kind: {
        schema: z.enum(["dossier", "imported-report", "generated-report"]),
        description: "Dossier, imported report or generated research job report",
      },
      subject: {
        schema: z.string().trim().min(1).max(200),
        description: "Saved subject contains this text",
      },
      theme: {
        schema: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
        description: "Dossier theme ID (dossiers only)",
      },
    },
    sorts: ["title", "path", "date"],
    async search(query) {
      const limitations: string[] = [];
      const after = query.cursor ? decodeCursor(query.cursor) : undefined;
      if (query.cursor && !after)
        limitations.push("The page link was not valid; showing the first page.");
      const rows: ResearchBrowseRow[] = [];
      const wantedKind = query.filters.kind as ResearchKind | undefined;
      const wantedSubject = (query.filters.subject as string | undefined)?.toLowerCase();
      const wantedTheme = query.filters.theme as string | undefined;
      let cursor: string | undefined;
      let scanned = 0;
      let unreadable = 0;
      let complete = true;
      // Sort order is global, so one page request must see the bounded set
      // before slicing; the scan bound keeps this from walking the corpus.
      while (scanned < RESEARCH_BROWSE_SCAN) {
        let page;
        try {
          page = await research.list({
            ...(query.text ? { query: query.text } : {}),
            ...(wantedKind ? { kind: wantedKind } : {}),
            ...(cursor ? { after: cursor } : {}),
          });
        } catch (error) {
          if (scanned === 0) throw error;
          limitations.push("The research collection could not be listed completely right now.");
          complete = false;
          break;
        }
        unreadable += page.unreadable;
        if (page.rows.length === 0) break;
        for (const row of page.rows) {
          scanned++;
          if (scanned > RESEARCH_BROWSE_SCAN) {
            complete = false;
            break;
          }
          if (wantedSubject && !(row.subject ?? "").toLowerCase().includes(wantedSubject)) continue;
          if (wantedTheme && dossierTheme(row.path) !== wantedTheme) continue;
          rows.push({
            id: row.path,
            summary: row.title,
            artifact: ref(row),
            kind: row.kind,
            ...(row.subject ? { subject: row.subject } : {}),
            ...(row.date ? { date: row.date } : {}),
          });
        }
        if (!complete) break;
        if (!page.next) break;
        cursor = page.next;
      }
      const sortKey = (r: ResearchBrowseRow) =>
        query.sort === "path" ? r.id : query.sort === "date" ? (r.date ?? "") : r.summary;
      rows.sort((a, b) => {
        const ka = sortKey(a);
        const kb = sortKey(b);
        const cmp = ka.localeCompare(kb) || a.id.localeCompare(b.id);
        return query.direction === "desc" ? -cmp : cmp;
      });
      const start = after ? rows.findIndex((r) => r.id === after[1]) + 1 : 0;
      // The cursor path is not necessarily in this scan if sort/filter changed;
      // fall back to the first page rather than skipping records silently.
      const from = start > 0 && after && sortKey(rows[start - 1]!) === after[0] ? start : 0;
      const pageRows = rows.slice(from, from + query.limit);
      const more = rows.length > from + query.limit;
      return {
        rows: pageRows,
        ...(pageRows.length > 0 && more
          ? { next: cursorOf(sortKey(pageRows.at(-1)!), pageRows.at(-1)!.id) }
          : {}),
        limitations: [
          ...limitations,
          ...(unreadable ? [`${unreadable} saved document(s) could not be read.`] : []),
          ...(!complete
            ? ["This page reached the scan bound; continue for later documents."]
            : []),
        ],
      };
    },
  };
}
