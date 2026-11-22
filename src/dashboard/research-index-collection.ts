import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import type { CollectionAdapter, CollectionPage, CollectionRow } from "./collection-query.js";

/**
 * Indexed dossier/report browser (#620, #617).
 *
 * Searches the existing research-collection index through the application's
 * search controller: no view reads Elasticsearch directly, and no artifact is
 * read here. Every row carries the exact artifact the index recorded, so the
 * detail reader opens the same revision that was searched.
 */

/** Documents the research-collection index may hold (see research-index.ts). */
export const RESEARCH_DOCUMENT_KINDS = [
  "dossier",
  "research-report",
  "covering-note",
  "source-snapshot",
] as const;
export type ResearchDocumentKind = (typeof RESEARCH_DOCUMENT_KINDS)[number];

/** Minimal search surface, satisfied by the Elasticsearch controller. */
export interface ResearchSearchPort {
  search(
    index: string,
    query: unknown,
    options: { size?: number; sort?: unknown; searchAfter?: unknown[] },
  ): Promise<Array<{ id: string; source: unknown; sort?: unknown[] }>>;
}

export const DEFAULT_RESEARCH_INDEX = "steele-research-collection-v1";

interface IndexedSource {
  kind?: unknown;
  path?: unknown;
  title?: unknown;
  jobId?: unknown;
  artifactRepository?: unknown;
  artifactCommit?: unknown;
  artifactHash?: unknown;
}

function artifactOf(source: IndexedSource): ArtifactReference | undefined {
  if (
    typeof source.path !== "string" ||
    typeof source.artifactRepository !== "string" ||
    typeof source.artifactCommit !== "string" ||
    typeof source.artifactHash !== "string"
  )
    return undefined;
  return {
    repository: source.artifactRepository,
    commit: source.artifactCommit,
    path: source.path,
    hash: source.artifactHash,
  };
}

export function researchIndexAdapter(
  search: ResearchSearchPort,
  options: { index?: string } = {},
): CollectionAdapter {
  const index = options.index ?? DEFAULT_RESEARCH_INDEX;
  return {
    name: "research",
    filters: {
      kind: { schema: z.enum(RESEARCH_DOCUMENT_KINDS), description: "document kind" },
      jobId: { schema: z.string().regex(/^research-[0-9a-f]{32}$/), description: "research job id" },
    },
    // Stable path ordering only: the index records no reliable date field.
    sorts: ["path"],
    async search(query): Promise<CollectionPage> {
      const must: unknown[] = [];
      if (query.text) must.push({ multi_match: { query: query.text, fields: ["title", "text"] } });
      const filter: unknown[] = [];
      if (typeof query.filters.kind === "string")
        filter.push({ term: { kind: query.filters.kind } });
      if (typeof query.filters.jobId === "string")
        filter.push({ term: { jobId: query.filters.jobId } });

      let hits: Array<{ id: string; source: unknown; sort?: unknown[] }>;
      try {
        hits = await search.search(
          index,
          must.length ? { bool: { must, filter } } : { bool: { filter } },
          {
            size: query.limit,
            sort: [{ path: { order: "asc" } }],
            ...(query.cursor ? { searchAfter: [query.cursor] } : {}),
          },
        );
      } catch {
        return { rows: [], limitations: ["the research index is unavailable right now"] };
      }

      const rows: CollectionRow[] = [];
      let unpinned = 0;
      for (const hit of hits) {
        const source = (hit.source ?? {}) as IndexedSource;
        const artifact = artifactOf(source);
        // Without the recorded artifact the document cannot be opened at the
        // revision that was searched, so it is reported rather than shown.
        if (!artifact) {
          unpinned += 1;
          continue;
        }
        rows.push({
          id: hit.id,
          summary: typeof source.title === "string" && source.title ? source.title : artifact.path,
          artifact,
        });
      }
      const last = hits[hits.length - 1];
      const next = hits.length === query.limit && last?.sort ? String(last.sort[0]) : undefined;
      return {
        rows,
        ...(next ? { next } : {}),
        limitations: unpinned
          ? [`${unpinned} indexed document(s) lack an artifact reference and were not shown`]
          : [],
      };
    },
  };
}
