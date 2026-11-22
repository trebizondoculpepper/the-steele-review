import { z } from "zod";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { ThemeMappingSchema, type ThemeMapping } from "../research/theme-mappings.js";
import type { CollectionAdapter, CollectionPage, CollectionRow } from "./collection-query.js";

/**
 * Theme mappings browser (#519): the librarian's saved proposal-to-canonical
 * theme decisions (#518), read-only through the artifact controller.
 *
 * It is the first browser built on the shared collection contract (#617):
 * allowlisted filters and sorts, one bounded page and an opaque cursor. The
 * saved Git files are the source of truth; nothing here recomputes a match,
 * runs a paid model or changes the corpus. A bounded scan that cannot see the
 * whole collection says so on the page.
 */

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;

const ROOT = "librarian/theme-mappings";
const MAPPING_PATH = /^librarian\/theme-mappings\/(?:global|scope-[^/]+)\/[^/]+\.json$/;
/** Bound on mapping files read for one page request. */
export const MAPPING_SCAN = 1_000;
const LIST_PAGE = 200;

export type MappingStatus = "resolved" | "unresolved" | "corrected";

export interface MappingRow extends CollectionRow {
  mapping: ThemeMapping;
  status: MappingStatus;
}

export const statusOf = (m: ThemeMapping): MappingStatus =>
  m.status === "unresolved" ? "unresolved" : m.correction ? "corrected" : "resolved";

const ref = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

const cursorOf = (sortKey: string, path: string) =>
  Buffer.from(JSON.stringify([sortKey, path])).toString("base64url");
function decodeCursor(cursor: string): [string, string] | undefined {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string")
      ? (v as [string, string])
      : undefined;
  } catch {
    return undefined;
  }
}

export function themeMappingCollection(content: Store): CollectionAdapter & {
  search(
    query: Parameters<CollectionAdapter["search"]>[0],
  ): Promise<CollectionPage & { rows: MappingRow[] }>;
} {
  return {
    name: "theme-mappings",
    filters: {
      theme: {
        schema: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
        description: "Canonical theme ID the mapping targets",
      },
      status: {
        schema: z.enum(["resolved", "unresolved", "corrected"]),
        description: "Resolved, corrected (revised in place) or unresolved",
      },
      method: {
        schema: z.enum(["embedding", "lexical", "manual", "unrecorded"]),
        description: "How the decision was made",
      },
    },
    sorts: ["decided", "proposal"],
    async search(query) {
      const limitations: string[] = [];
      const after = query.cursor ? decodeCursor(query.cursor) : undefined;
      if (query.cursor && !after)
        limitations.push("The page link was not valid; showing the first page.");
      // Bounded scan of the saved files; their content decides each row.
      const rows: MappingRow[] = [];
      let listed: string | undefined;
      let scanned = 0;
      let unreadable = 0;
      let complete = true;
      for (;;) {
        let paths: string[];
        try {
          paths = await content.list(ROOT, LIST_PAGE, listed);
        } catch (error) {
          // No authoritative scan at all is "unavailable", never "empty".
          if (scanned === 0) throw error;
          limitations.push("The saved mappings could not be listed completely right now.");
          complete = false;
          break;
        }
        for (const path of paths) {
          listed = path;
          if (!MAPPING_PATH.test(path)) continue;
          if (scanned++ >= MAPPING_SCAN) {
            complete = false;
            break;
          }
          try {
            const r = await content.lookup(path);
            if (!r) continue;
            const parsed = ThemeMappingSchema.safeParse(JSON.parse(await content.read(r)));
            if (!parsed.success) {
              unreadable++;
              continue;
            }
            const m = parsed.data;
            rows.push({
              id: path,
              summary: m.proposal,
              artifact: ref(r),
              mapping: m,
              status: statusOf(m),
            });
          } catch {
            unreadable++;
          }
        }
        if (!complete || paths.length < LIST_PAGE) break;
      }
      if (!complete)
        limitations.push(
          `Only the first ${MAPPING_SCAN} saved mappings were examined; later ones are not shown.`,
        );
      if (unreadable > 0 && rows.length === 0) throw new Error("no saved mapping could be read");
      if (unreadable > 0) limitations.push(`${unreadable} saved mapping(s) could not be read.`);

      const text = query.text?.toLowerCase();
      const f = query.filters as { theme?: string; status?: MappingStatus; method?: string };
      const matching = rows.filter((r) => {
        const m = r.mapping;
        if (f.theme && m.canonicalThemeId !== f.theme) return false;
        if (f.status && r.status !== f.status) return false;
        if (f.method && (m.method ?? "unrecorded") !== f.method) return false;
        if (text) {
          const hay =
            `${m.proposal}\n${m.description ?? ""}\n${m.scope ?? ""}\n${m.canonicalThemeId}`.toLowerCase();
          if (!hay.includes(text)) return false;
        }
        return true;
      });
      const keyOf = (r: MappingRow) =>
        query.sort === "proposal" ? r.mapping.proposal.toLowerCase() : r.mapping.decidedAt;
      const dir = query.direction === "asc" ? 1 : -1;
      matching.sort((a, b) => {
        const k = keyOf(a).localeCompare(keyOf(b));
        return k !== 0 ? k * dir : a.id.localeCompare(b.id);
      });
      // Continue strictly after the cursor's (key, path) position.
      const start = after
        ? matching.findIndex((r) => {
            const k = keyOf(r).localeCompare(after[0]) * dir;
            return k > 0 || (k === 0 && r.id.localeCompare(after[1]) > 0);
          })
        : 0;
      const pageRows = start < 0 ? [] : matching.slice(start, start + query.limit);
      const last = pageRows.at(-1);
      const more = start >= 0 && start + query.limit < matching.length;
      return {
        rows: pageRows,
        ...(more && last ? { next: cursorOf(keyOf(last), last.id) } : {}),
        limitations,
      };
    },
  };
}

export interface MappingDetail {
  mapping: ThemeMapping;
  status: MappingStatus;
  /** The version shown: current, or the pinned one asked for. */
  current: ArtifactRef;
}

/**
 * One saved mapping: its current version, or exactly a pinned version (as a
 * coverage record pins it) when commit and hash are given. The store verifies
 * the pinned bytes against the hash; nothing is guessed.
 */
export async function mappingDetail(
  content: Pick<GitArtifactStore, "lookup" | "read">,
  path: string,
  pinned?: { repository: string; commit: string; sha256: string },
): Promise<MappingDetail | undefined> {
  if (!MAPPING_PATH.test(path)) return undefined;
  if (pinned && (!/^[0-9a-f]{40}$/.test(pinned.commit) || !/^[0-9a-f]{64}$/.test(pinned.sha256)))
    return undefined;
  try {
    const r = pinned ? { ...pinned, path } : await content.lookup(path);
    if (!r) return undefined;
    const parsed = ThemeMappingSchema.safeParse(JSON.parse(await content.read(r)));
    if (!parsed.success) return undefined;
    return { mapping: parsed.data, status: statusOf(parsed.data), current: r };
  } catch {
    return undefined;
  }
}
