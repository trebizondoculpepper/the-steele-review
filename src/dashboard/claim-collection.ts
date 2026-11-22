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

const encodeCursor = (from: string | undefined, path: string, index: number) =>
  Buffer.from(JSON.stringify([from ?? null, path, index])).toString("base64url");
function decodeCursor(
  cursor: string,
): { from?: string; path: string; index: number } | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) &&
      value.length === 3 &&
      (value[0] === null || typeof value[0] === "string") &&
      typeof value[1] === "string" &&
      typeof value[2] === "number" &&
      Number.isSafeInteger(value[2]) &&
      value[2] >= 0
      ? {
          ...(value[0] === null ? {} : { from: value[0] as string }),
          path: value[1] as string,
          index: value[2] as number,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

type Store = Pick<GitArtifactStore, "list" | "lookup">;

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
      const cursor =
        query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      if (query.cursor && cursor === undefined)
        limitations.push("The page link was not valid; showing the first page.");
      const category = query.filters.category as ClaimCategory | undefined;
      const post = query.filters.post as string | undefined;
      const theme = query.filters.theme as string | undefined;
      const kind = query.filters.kind as ClaimRow["kind"] | undefined;
      const [pubFilter, postFilter] = post?.includes("/")
        ? (post.split("/", 2) as [string, string])
        : [undefined, post];
      const text = query.text?.trim().toLowerCase();

      if (!claims.rowsFor) throw new Error("claim reader does not expose rows");
      const rows: ClaimBrowseRow[] = [];
      let listing: string | undefined = cursor?.from;
      const skip = cursor?.index ?? 0;
      let examined = 0;
      let unreadable = 0;
      let complete = true;
      let lastPath: string | undefined;
      let lastIndex = 0;
      // Path immediately before the extraction currently being consumed; the
      // continuation re-lists from here so an intra-extraction offset resumes.
      let priorPath: string | undefined = cursor?.from;
      let beforeLast: string | undefined = cursor?.from;
      let exhausted = false;
      while (rows.length < query.limit && examined < CLAIM_BROWSE_SCAN) {
        let paths: string[];
        try {
          paths = await content.list("claim-extractions", 50, listing);
        } catch (error) {
          if (rows.length === 0 && listing === undefined) throw error;
          limitations.push("The claim collection could not be listed completely right now.");
          complete = false;
          break;
        }
        if (paths.length === 0) {
          exhausted = true;
          break;
        }
        for (const path of paths) {
          if (examined >= CLAIM_BROWSE_SCAN) break;
          listing = path;
          if (!/^claim-extractions\/[^/]+\/[^/]+\/[^/]+\.json$/.test(path)) continue;
          examined++;
          let all;
          try {
            all = await claims.rowsFor(path);
          } catch {
            unreadable++;
            continue;
          }
          if (!all) {
            unreadable++;
            continue;
          }
          for (let i = 0; i < all.length; i++) {
            const row = all[i]!;
            if (path === cursor?.path && i < skip) continue;
            if (category && row.category !== category) continue;
            if (
              text &&
              !(row.statement ?? "").toLowerCase().includes(text) &&
              !(row.passage ?? "").toLowerCase().includes(text)
            )
              continue;
            if (pubFilter && row.publicationId !== pubFilter) continue;
            if (postFilter && row.postId !== postFilter) continue;
            if (theme && !row.themes.some((th) => th.id === theme)) continue;
            if (kind && row.kind !== kind) continue;
            let artifact: CollectionRow["artifact"] | undefined;
            try {
              const ref = await content.lookup(path);
              if (ref) {
                artifact = {
                  repository: ref.repository,
                  commit: ref.commit,
                  path: ref.path,
                  hash: `sha256:${ref.sha256}`,
                };
              }
            } catch {
              // Reported through the row limitation below.
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
            if (lastPath !== path) beforeLast = priorPath;
            lastPath = path;
            lastIndex = i + 1;
            examined++;
            if (rows.length >= query.limit || examined >= CLAIM_BROWSE_SCAN) break;
          }
          priorPath = path;
          if (rows.length >= query.limit || examined >= CLAIM_BROWSE_SCAN) break;
        }
        if (rows.length >= query.limit || examined >= CLAIM_BROWSE_SCAN) break;
        if (paths.length < 50) {
          exhausted = true;
          break;
        }
      }
      if (examined >= CLAIM_BROWSE_SCAN && rows.length < query.limit) complete = false;
      const more =
        rows.length === query.limit || (!complete && lastPath !== undefined);
      const after =
        more && lastPath ? encodeCursor(beforeLast, lastPath, lastIndex) : undefined;
      return {
        rows,
        ...(after ? { next: after } : {}),
        limitations: [
          ...limitations,
          ...(unreadable ? [`${unreadable} saved extraction(s) could not be read.`] : []),
          ...(!complete && examined >= CLAIM_BROWSE_SCAN
            ? ["This search reached its scan bound; narrow the filters to reach later records."]
            : []),
        ],
      };
    },
  };
}
