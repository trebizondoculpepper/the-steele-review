import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import type { ClaimsPort, ClaimRow } from "./claims.js";
import type { CollectionAdapter, CollectionPage, CollectionRow } from "./collection-query.js";

/** Opaque cursor: the port's own cursor plus an offset within that fetch. */
export function encodeCursor(cursor: { page?: string; offset: number }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string | undefined): { page?: string; offset: number } {
  if (!raw) return { offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      page?: unknown;
      offset?: unknown;
    };
    return {
      ...(typeof parsed.page === "string" ? { page: parsed.page } : {}),
      offset: typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0,
    };
  } catch {
    return { offset: 0 };
  }
}

/**
 * Claim-record browser on the shared collection contract (#619, #617).
 *
 * The adapter is thin on purpose: it lists through the existing claims port,
 * keeps the exact saved extraction reference on every row so a detail reader
 * can pin it, and reports the port's own freshness/limitation state rather than
 * inventing one.
 */

const Post = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, "publication/post");

export const CLAIM_CATEGORIES = ["accepted", "candidate", "rejected", "legacy"] as const;

/** Stable identity of a claim row within its saved extraction. */
export function claimRowId(row: ClaimRow): string {
  return `${row.result}#${row.category}:${row.index}`;
}

/**
 * The exact artifact a row came from. A row whose saved extraction reference is
 * not recorded is not silently given a fabricated one.
 */
export function claimRowArtifact(row: ClaimRow): ArtifactReference | undefined {
  if (!row.resultCommit || !row.resultHash) return undefined;
  return {
    repository: "content",
    commit: row.resultCommit,
    path: row.result,
    hash: row.resultHash,
  };
}

/** One-line summary that never invents wording the extraction did not record. */
function summaryOf(row: ClaimRow): string {
  const text = row.statement?.trim() || row.passage?.trim();
  if (text) return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  return row.rejectionReason ? `rejected: ${row.rejectionReason}` : "(no statement saved)";
}

export function claimsCollectionAdapter(claims: ClaimsPort): CollectionAdapter {
  return {
    name: "claims",
    filters: {
      post: { schema: Post, description: "publication/post" },
      category: {
        schema: z.enum(CLAIM_CATEGORIES),
        description: "accepted, candidate, rejected or legacy",
      },
    },
    // Only what the adapter actually implements; the port returns newest-first.
    sorts: ["recent"],
    async search(query): Promise<CollectionPage> {
      // The port filters by post id alone, so the publication half is applied
      // here rather than pretending the port understood "publication/post".
      const postFilter =
        typeof query.filters.post === "string" ? query.filters.post.split("/") : undefined;
      const cursor = decodeCursor(query.cursor);
      const listing = await claims.list({
        ...(query.text ? { query: query.text } : {}),
        ...(postFilter ? { post: postFilter[1]! } : {}),
        ...(typeof query.filters.category === "string"
          ? { category: query.filters.category as ClaimRow["category"] }
          : {}),
        ...(cursor.page ? { after: cursor.page } : {}),
      });
      if (listing.state === "unavailable")
        return { rows: [], limitations: ["saved claim results are unavailable right now"] };

      const rows: CollectionRow[] = [];
      const skipped: string[] = [];
      let wrongPublication = 0;
      for (const row of listing.rows) {
        if (postFilter && row.publicationId !== postFilter[0]) {
          wrongPublication += 1;
          continue;
        }
        const artifact = claimRowArtifact(row);
        // Without an exact reference the row cannot be opened, so it is
        // reported rather than shown as if it could be.
        if (!artifact) {
          skipped.push(claimRowId(row));
          continue;
        }
        rows.push({
          id: claimRowId(row),
          summary: summaryOf(row),
          artifact,
          ...(row.quoteRecovered
            ? { limitations: ["quotation recovered by a formatting rule, not verbatim"] }
            : {}),
        });
      }

      const limitations = [
        ...(listing.partial ? ["the claim scan reached its bound before a full page of matches"] : []),
        ...(listing.unreadable ? [`${listing.unreadable} saved extraction(s) could not be read`] : []),
        ...(skipped.length
          ? [`${skipped.length} row(s) have no exact extraction reference and were not shown`]
          : []),
        ...(wrongPublication
          ? [`${wrongPublication} row(s) belonged to another publication and were excluded`]
          : []),
      ];
      // Honour the page bound with a row-level cursor: the port's cursor only
      // advances whole fetches, so the remaining rows of this fetch are resumed
      // by offset rather than dropped.
      const start = cursor.offset;
      const pageRows = rows.slice(start, start + query.limit);
      const next =
        rows.length > start + query.limit
          ? encodeCursor({ page: cursor.page, offset: start + query.limit })
          : listing.next
            ? encodeCursor({ page: listing.next, offset: 0 })
            : undefined;
      return { rows: pageRows, ...(next ? { next } : {}), limitations };
    },
  };
}
