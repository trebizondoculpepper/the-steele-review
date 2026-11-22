import { z } from "zod";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { ClaimCategory, ClaimsPort, ClaimRow } from "./claims.js";
import type { CollectionAdapter, CollectionPage } from "./collection-query.js";
import type { CollectionRow } from "./collection-query.js";

/**
 * Claim browser on the shared collection contract (#619).
 *
 * Adapter over the saved claim extractions (#494): accepted occurrences,
 * legacy extractions, refinement candidates and rejected diagnostics remain
 * distinct categories. Rows keep their exact extraction revision and link to
 * the existing claim detail; nothing is merged by display text, re-extracted
 * or re-assessed here.
 */

export const CLAIM_BROWSE_SCAN = 2_000;

export interface ClaimBrowseRow extends CollectionRow {
  row: ClaimRow;
}

const ordinalCursor = (n: number) => Buffer.from(String(n)).toString("base64url");
function decodeOrdinal(cursor: string): number | undefined {
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^\d+$/.test(text)) return undefined;
    const n = Number.parseInt(text, 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

type Store = Pick<GitArtifactStore, "lookup">;

export function claimCollection(
  content: Store,
  claims: ClaimsPort,
): CollectionAdapter & {
  search(
    query: Parameters<CollectionAdapter["search"]>[0],
  ): Promise<CollectionPage & { rows: ClaimBrowseRow[] }>;
} {
  return {
    name: "claims",
    filters: {
      category: {
        schema: z.enum(["accepted", "legacy", "candidate", "rejected"]),
        description: "Accepted occurrence, legacy extraction, candidate or rejection",
      },
      post: {
        schema: z.string().trim().min(1).max(400),
        description: "publication/post identity",
      },
      theme: {
        schema: z.string().regex(/^theme-[0-9a-f]{24}$/),
        description: "Theme proposal ID recorded on the extraction",
      },
      kind: {
        schema: z.enum(["assertion", "quotation", "question", "speculation"]),
        description: "Recorded assertion kind",
      },
    },
    // Reader order is the only order a resumable scan can honour.
    sorts: ["stored"],
    async search(query) {
      const limitations: string[] = [];
      const cursor = query.cursor ? decodeOrdinal(query.cursor) : 0;
      if (query.cursor && cursor === undefined)
        limitations.push("The page link was not valid; showing the first page.");
      const start = cursor ?? 0;
      const category = query.filters.category as ClaimCategory | undefined;
      const post = query.filters.post as string | undefined;
      const theme = query.filters.theme as string | undefined;
      const kind = query.filters.kind as ClaimRow["kind"] | undefined;

      const collected: ClaimRow[] = [];
      let after: string | undefined;
      let scanned = 0;
      let unreadable = 0;
      let complete = true;
      for (;;) {
        let page;
        try {
          page = await claims.list({
            ...(query.text ? { query: query.text } : {}),
            ...(post ? { post } : {}),
            ...(theme ? { theme } : {}),
            ...(category ? { category } : {}),
            ...(after ? { after } : {}),
          });
        } catch (error) {
          if (collected.length === 0 && after === undefined) throw error;
          limitations.push("The claim collection could not be listed completely right now.");
          complete = false;
          break;
        }
        if (page.state === "unavailable") {
          if (collected.length === 0 && after === undefined)
            throw new Error("claim collection unavailable");
          limitations.push("Part of the claim collection is unavailable right now.");
          complete = false;
          break;
        }
        unreadable += page.unreadable;
        for (const row of page.rows) {
          scanned++;
          if (kind && row.kind !== kind) continue;
          collected.push(row);
          if (scanned >= CLAIM_BROWSE_SCAN) {
            complete = false;
            break;
          }
        }
        if (!complete) break;
        if (!page.next) break;
        after = page.next;
      }
      const selected = collected.slice(start, start + query.limit);
      const more = collected.length > start + query.limit;
      const refCache = new Map<string, CollectionRow["artifact"]>();
      const rows: ClaimBrowseRow[] = [];
      for (const row of selected) {
        let artifact = refCache.get(row.result);
        if (!artifact) {
          try {
            const ref = await content.lookup(row.result);
            if (ref) {
              artifact = {
                repository: ref.repository,
                commit: ref.commit,
                path: ref.path,
                hash: `sha256:${ref.sha256}`,
              };
              refCache.set(row.result, artifact);
            }
          } catch {
            // An unreadable extraction is reported through the row limitation.
          }
        }
        rows.push({
          id: `${row.result}#${row.category}:${row.index}`,
          summary: row.statement ?? `${row.category} entry ${row.index}`,
          artifact: artifact ?? {
            repository: "content",
            commit: "0".repeat(40),
            path: row.result,
            hash: `sha256:${"0".repeat(64)}`,
          },
          ...(artifact ? {} : { limitations: ["The saved extraction could not be read."] }),
          row,
        });
      }
      return {
        rows,
        ...(more ? { next: ordinalCursor(start + query.limit) } : {}),
        limitations: [
          ...limitations,
          ...(unreadable ? [`${unreadable} saved extraction(s) could not be read.`] : []),
          ...(!complete && scanned >= CLAIM_BROWSE_SCAN
            ? ["This search reached its scan bound; narrow the filters to reach later records."]
            : []),
        ],
      };
    },
  };
}
