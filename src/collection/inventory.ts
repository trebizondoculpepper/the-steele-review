import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { CollectionRecordSchema } from "./collection-store.js";

/**
 * Read-only inventory of captured posts (#186), through the artifact
 * controller's list/read methods only. It never initialises storage: an
 * unreadable or missing archive is an error, not an empty result.
 */

export const MAX_INVENTORY_LIMIT = 500;
/** Upper bound on archive paths scanned per call. */
export const MAX_SCAN = 100_000;

const RECORD_PATH =
  /^substack\/([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9-]{0,299})\/collected\.json$/;

export interface InventoryEntry {
  publicationId: string;
  postId: string;
  title: string;
  url: string;
  publishedAt?: string;
  complete: boolean;
  textChars: number;
  method: string;
}

export interface InventoryResult {
  posts: InventoryEntry[];
  /** Records that exist but could not be read or validated, by identity only. */
  malformed: Array<{ publicationId: string; postId: string }>;
  /** True when more matching posts exist beyond this page. */
  truncated: boolean;
  /** Pass as `after` to read the next page. */
  next?: string;
}

export async function listCapturedPosts(
  archive: Pick<GitArtifactStore, "list" | "lookup" | "read">,
  options: {
    publicationId?: string;
    limit?: number;
    after?: string;
    completeOnly?: boolean;
    /** Paths scanned per call; tests lower it. */
    scanLimit?: number;
  } = {},
): Promise<InventoryResult> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), MAX_INVENTORY_LIMIT));
  const prefix = options.publicationId ? `substack/${options.publicationId}` : "substack";
  // The cursor is applied by the controller, so pages beyond the scan budget
  // stay reachable; a full scan window means more paths may exist.
  const scanned = await archive.list(
    prefix,
    options.scanLimit ?? MAX_SCAN,
    options.after ? cursorPath(options.after) : undefined,
  );
  const scanFull = scanned.length >= (options.scanLimit ?? MAX_SCAN);
  const paths = scanned.filter((p) => RECORD_PATH.test(p));
  const posts: InventoryEntry[] = [];
  const malformed: InventoryResult["malformed"] = [];
  let last: string | undefined;
  let index = 0;
  for (; index < paths.length && posts.length < limit; index++) {
    const path = paths[index];
    const [, publicationId, postId] = RECORD_PATH.exec(path)!;
    last = `${publicationId}/${postId}`;
    try {
      const ref = await archive.lookup(path);
      if (!ref) throw new Error("missing");
      const record = CollectionRecordSchema.parse(JSON.parse(await archive.read(ref)));
      if (options.completeOnly && !record.complete) continue;
      posts.push({
        publicationId,
        postId,
        title: record.item.title,
        url: record.item.url,
        ...(record.item.publishedAt ? { publishedAt: record.item.publishedAt } : {}),
        complete: record.complete,
        textChars: record.text.length,
        method: record.provenance.method,
      });
    } catch (error) {
      // Storage failures stay failures; only an unreadable record is "malformed".
      if (
        error instanceof Error &&
        error.name === "ArtifactStoreError" &&
        (error as { code?: string }).code === "git-failed"
      ) {
        throw error;
      }
      malformed.push({ publicationId, postId });
    }
  }
  const truncated = index < paths.length || (scanFull && last !== undefined);
  return { posts, malformed, truncated, ...(truncated && last ? { next: last } : {}) };
}

/** Cursor "publication/post" to the record path it stands for. */
function cursorPath(cursor: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,299}$/.test(cursor)) {
    throw new Error("invalid cursor");
  }
  return `substack/${cursor}/collected.json`;
}
