import { z } from "zod";
import { ArtifactStoreError, type GitArtifactStore } from "../controllers/artifact-store.js";

/**
 * Canonical themes, independent of research (#528).
 *
 * A theme is an established topic with a stable ID, title and description. A
 * dossier is the versioned research about a theme and may not exist yet.
 * Extraction proposals are neither. Recording a theme therefore never creates
 * an empty research document, and "no dossier" stays a distinct, readable
 * state rather than a fabricated one.
 */

export const THEME_SCHEMA_VERSION = 1;

const ThemeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);

export const CanonicalThemeSchema = z
  .object({
    schemaVersion: z.literal(THEME_SCHEMA_VERSION),
    /** Stable canonical identity; reusable mappings target this. */
    id: ThemeId,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CanonicalTheme = z.infer<typeof CanonicalThemeSchema>;

/**
 * Canonical themes live under their own prefix: `themes/` already holds
 * per-post extraction results (`themes/<publication>/<post>/...`), and mixing
 * the two would make a canonical listing return non-canonical records.
 */
export function themePath(id: string): string {
  return `canonical-themes/${id}.json`;
}

export class ThemeStore {
  constructor(
    private readonly artifacts: Pick<GitArtifactStore, "lookup" | "read" | "write" | "list">,
  ) {}

  async get(id: string): Promise<CanonicalTheme | undefined> {
    const ref = await this.artifacts.lookup(themePath(id));
    if (!ref) return undefined;
    const parsed = CanonicalThemeSchema.safeParse(JSON.parse(await this.artifacts.read(ref)));
    return parsed.success ? parsed.data : undefined;
  }

  /** A theme that must exist and be valid; read or parse failures propagate. */
  async require(id: string): Promise<CanonicalTheme> {
    const ref = await this.artifacts.lookup(themePath(id));
    if (!ref) throw new Error("canonical theme listed but not found");
    return CanonicalThemeSchema.parse(JSON.parse(await this.artifacts.read(ref)));
  }

  /**
   * Record a canonical theme. Write-once: the first title wins, so an
   * established topic is not silently renamed by a later post's wording.
   */
  async ensure(theme: Omit<CanonicalTheme, "schemaVersion">): Promise<CanonicalTheme> {
    const payload = CanonicalThemeSchema.parse({ schemaVersion: THEME_SCHEMA_VERSION, ...theme });
    const existing = await this.get(payload.id);
    if (existing) return existing;
    try {
      await this.artifacts.write(themePath(payload.id), `${JSON.stringify(payload, null, 2)}\n`);
      return payload;
    } catch (error) {
      // A concurrent assessment may have established the same theme first; the
      // stored record is authoritative, so reconcile instead of failing.
      if (error instanceof ArtifactStoreError && error.code === "immutable-conflict") {
        const winner = await this.get(payload.id);
        if (winner) return winner;
      }
      throw error;
    }
  }

  /** One page of canonical theme paths in stable order, resumable after a path. */
  async listPage(limit: number, after?: string): Promise<string[]> {
    return this.artifacts.list("canonical-themes", limit, after);
  }

  /** Themes in stable ID order, bounded. */
  async list(limit = 500): Promise<string[]> {
    return this.artifacts.list("canonical-themes", limit);
  }
}

/**
 * Every canonical theme, paged to the end. A listed theme that cannot be read
 * or parsed is a failure, never an absence: treating it as missing could mint
 * a duplicate identity and commission redundant research, so the caller's
 * assessment fails and stays safely retryable.
 */
export async function listCanonicalThemes(store: ThemeStore): Promise<CanonicalTheme[]> {
  const ids: string[] = [];
  for (let after: string | undefined; ;) {
    const page = await store.listPage(1000, after);
    ids.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1];
  }
  const themes: CanonicalTheme[] = [];
  for (const path of ids) {
    const id = /^canonical-themes\/([^/]+)\.json$/.exec(path)?.[1];
    if (!id) continue;
    themes.push(await store.require(id));
  }
  return themes;
}
