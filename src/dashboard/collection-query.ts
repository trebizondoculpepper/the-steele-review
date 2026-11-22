import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";

/**
 * Shared indexed-collection query contract for dashboard browsers (#617).
 *
 * One validated query shape, one bounded page, one opaque cursor and one row
 * shape, so a new collection is a thin adapter rather than another bespoke
 * search implementation. Protocol details stay in each collection's adapter:
 * Elasticsearch stays inside its controller and artifacts stay inside the Git
 * controller. Nothing here reads a store.
 */

export const MAX_QUERY_TEXT = 200;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/** One row of any collection browser. */
export interface CollectionRow {
  /** Stable logical identity within the collection. */
  id: string;
  /** Human summary: title, name or short description. */
  summary: string;
  /** Exact artifact the row was projected from. */
  artifact: ArtifactReference;
  /** Why the row may be incomplete or stale, when known. */
  limitations?: string[];
}

export type CollectionSortDirection = "asc" | "desc";

/** A parsed, validated query handed to an adapter. */
export interface CollectionQuery {
  text?: string;
  filters: Record<string, unknown>;
  sort: string;
  direction: CollectionSortDirection;
  limit: number;
  cursor?: string;
}

export interface CollectionPage {
  rows: CollectionRow[];
  /** Opaque cursor for the next page; absent when exhausted. */
  next?: string;
  /** Page-level caveats (scan bounds, unreadable sources). */
  limitations: string[];
}

export interface CollectionFilterSpec {
  /** Validates and coerces one query-string value. */
  schema: z.ZodType<unknown>;
  description: string;
}

/**
 * A collection's thin adapter. Filters and sorts are allowlists, so a query
 * can never reach a field the collection did not publish.
 */
export interface CollectionAdapter {
  /** Stable collection name, e.g. "themes". */
  name: string;
  filters: Record<string, CollectionFilterSpec>;
  sorts: string[];
  /** Adapter-owned search; validates nothing, receives an already-valid input. */
  search(query: CollectionQuery): Promise<CollectionPage>;
}

export class CollectionQueryError extends Error {
  constructor(
    readonly code: "unknown-filter" | "invalid-filter" | "unknown-sort" | "invalid-limit",
    readonly keys: string[] = [],
  ) {
    super(`collection query: ${code}${keys.length ? ` (${keys.join(", ")})` : ""}`);
    this.name = "CollectionQueryError";
  }
}

const RawQuerySchema = z
  .object({
    text: z.string().optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
    sort: z.string().optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    limit: z.union([z.number(), z.string()]).optional(),
    cursor: z.string().optional(),
  })
  .strict();

export type RawCollectionQuery = z.input<typeof RawQuerySchema>;

/**
 * Validate a raw query against one adapter's allowlists.
 *
 * Unknown filters and sorts are refused rather than ignored: silently dropping
 * a filter would show the operator a broader result than they asked for.
 */
export function validateCollectionQuery(
  adapter: CollectionAdapter,
  raw: RawCollectionQuery,
): CollectionQuery {
  const parsed = RawQuerySchema.parse(raw);
  const text = parsed.text?.trim();
  if (text !== undefined && text.length > MAX_QUERY_TEXT)
    throw new CollectionQueryError("invalid-filter", ["text"]);

  const requested = parsed.filters ?? {};
  const unknown = Object.keys(requested).filter((k) => !(k in adapter.filters));
  if (unknown.length > 0) throw new CollectionQueryError("unknown-filter", unknown);

  const filters: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(requested)) {
    if (value === undefined || value === "") continue;
    const result = adapter.filters[key]!.schema.safeParse(value);
    if (result.success) filters[key] = result.data;
    else invalid.push(key);
  }
  if (invalid.length > 0) throw new CollectionQueryError("invalid-filter", invalid);

  const sort = parsed.sort ?? adapter.sorts[0];
  if (sort === undefined) throw new CollectionQueryError("unknown-sort", []);
  if (!adapter.sorts.includes(sort)) throw new CollectionQueryError("unknown-sort", [sort]);

  const rawLimit = parsed.limit === undefined ? DEFAULT_PAGE_SIZE : Number(parsed.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1)
    throw new CollectionQueryError("invalid-limit", [String(parsed.limit)]);
  const limit = Math.min(rawLimit, MAX_PAGE_SIZE);

  return {
    ...(text ? { text } : {}),
    filters,
    sort,
    direction: parsed.direction ?? "desc",
    limit,
    ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
  };
}

/** Validate and run one page of any collection. */
export async function queryCollection(
  adapter: CollectionAdapter,
  raw: RawCollectionQuery,
): Promise<CollectionPage> {
  const query = validateCollectionQuery(adapter, raw);
  const page = await adapter.search(query);
  // The adapter owns paging, but the contract keeps the page bounded.
  return { ...page, rows: page.rows.slice(0, query.limit) };
}

/** Build a raw query from URL search params, keeping filters namespaced. */
export function collectionQueryFromParams(url: URL, filterPrefix = "f."): RawCollectionQuery {
  const filters: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (key.startsWith(filterPrefix)) filters[key.slice(filterPrefix.length)] = value;
  }
  const text = url.searchParams.get("q") ?? undefined;
  const sort = url.searchParams.get("sort") ?? undefined;
  const direction = url.searchParams.get("dir") ?? undefined;
  const limit = url.searchParams.get("limit") ?? undefined;
  const cursor = url.searchParams.get("after") ?? undefined;
  return {
    ...(text ? { text } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(sort ? { sort } : {}),
    ...(direction === "asc" || direction === "desc" ? { direction } : {}),
    ...(limit ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Shared list rendering: escaped summary, exact reference and caveats. */
export function renderCollectionPage(page: CollectionPage): string {
  const notes = page.limitations.map((l) => `<p class="empty">${esc(l)}</p>`).join("");
  if (page.rows.length === 0) return `${notes}<p class="empty">No matching records.</p>`;
  const rows = page.rows
    .map(
      (r) =>
        `<tr><td>${esc(r.summary)}</td><td><code>${esc(`${r.artifact.commit.slice(0, 12)}:${r.artifact.path}`)}</code></td><td>${
          r.limitations?.length ? esc(r.limitations.join("; ")) : "—"
        }</td></tr>`,
    )
    .join("");
  return `${notes}<div class="wrap"><table><thead><tr><th>Record</th><th>Artifact</th><th>Limitations</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
