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
      const rows: ResearchBrowseRow[] = [];
      const wantedKind = query.filters.kind as ResearchKind | undefined;
      const wantedSubject = (query.filters.subject as string | undefined)?.toLowerCase();
      const wantedTheme = query.filters.theme as string | undefined;
      // The cursor is the reader's own listing position, so pages remain
      // resumable even when a filter matches nothing in an earlier window.
      const validCursor =
        query.cursor === undefined ||
        /^(?:dossier|research-reports|research-jobs)\/[A-Za-z0-9._/-]+$/.test(query.cursor);
      if (!validCursor) limitations.push("The page link was not valid; showing the first page.");
      let cursor: string | undefined = validCursor ? query.cursor : undefined;
      let unreadable = 0;
      let complete = true;
      let lastConsumed: string | undefined;
      let examined = 0;
      while (rows.length < query.limit && examined < RESEARCH_BROWSE_SCAN) {
        let page;
        try {
          page = await research.list({
            ...(query.text ? { query: query.text } : {}),
            ...(wantedKind ? { kind: wantedKind } : {}),
            ...(cursor ? { after: cursor } : {}),
          });
        } catch (error) {
          if (rows.length === 0 && !cursor) throw error;
          limitations.push("The research collection could not be listed completely right now.");
          complete = false;
          break;
        }
        if (page.state === "unavailable") {
          if (rows.length === 0 && !cursor) throw new Error("research unavailable");
          limitations.push("Part of the research collection is unavailable right now.");
          complete = false;
          break;
        }
        unreadable += page.unreadable;
        for (const row of page.rows) {
          examined++;
          cursor = row.path;
          lastConsumed = row.path;
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
          if (rows.length >= query.limit || examined >= RESEARCH_BROWSE_SCAN) break;
        }
        if (rows.length >= query.limit || examined >= RESEARCH_BROWSE_SCAN) break;
        if (!page.next) break;
        cursor = page.next;
      }
      if (examined >= RESEARCH_BROWSE_SCAN && rows.length < query.limit) complete = false;
      // Sort applies within the returned page; the reader's stable listing
      // order is what pagination and cursors follow.
      const sortKey = (r: ResearchBrowseRow) =>
        query.sort === "path" ? r.id : query.sort === "date" ? (r.date ?? "") : r.summary;
      rows.sort((a, b) => {
        const ka = sortKey(a);
        const kb = sortKey(b);
        const cmp = ka.localeCompare(kb) || a.id.localeCompare(b.id);
        return query.direction === "desc" ? -cmp : cmp;
      });
      const pageRows = rows;
      const more = pageRows.length === query.limit;
      return {
        rows: pageRows,
        ...(more && lastConsumed ? { next: lastConsumed } : {}),
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
