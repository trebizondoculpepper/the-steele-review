import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import type { ClaimsPort, ClaimRow } from "./claims.js";
import type { CollectionAdapter, CollectionPage, CollectionRow } from "./collection-query.js";

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
    sorts: ["recent", "statement"],
    async search(query): Promise<CollectionPage> {
      const listing = await claims.list({
        ...(query.text ? { query: query.text } : {}),
        ...(typeof query.filters.post === "string" ? { post: query.filters.post } : {}),
        ...(typeof query.filters.category === "string"
          ? { category: query.filters.category as ClaimRow["category"] }
          : {}),
        ...(query.cursor ? { after: query.cursor } : {}),
      });
      if (listing.state === "unavailable")
        return { rows: [], limitations: ["saved claim results are unavailable right now"] };

      const rows: CollectionRow[] = [];
      const skipped: string[] = [];
      for (const row of listing.rows) {
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
      ];
      return { rows, ...(listing.next ? { next: listing.next } : {}), limitations };
    },
  };
}
