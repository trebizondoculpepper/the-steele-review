import { z } from "zod";
import type { GitArtifactStore } from "../controllers/artifact-store.js";

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

export function themePath(id: string): string {
  return `themes/${id}.json`;
}

export class ThemeStore {
  constructor(private readonly artifacts: Pick<GitArtifactStore, "lookup" | "read" | "write" | "list">) {}

  async get(id: string): Promise<CanonicalTheme | undefined> {
    const ref = await this.artifacts.lookup(themePath(id));
    if (!ref) return undefined;
    const parsed = CanonicalThemeSchema.safeParse(JSON.parse(await this.artifacts.read(ref)));
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Record a canonical theme. Write-once: the first title wins, so an
   * established topic is not silently renamed by a later post's wording.
   */
  async ensure(theme: Omit<CanonicalTheme, "schemaVersion">): Promise<CanonicalTheme> {
    const payload = CanonicalThemeSchema.parse({ schemaVersion: THEME_SCHEMA_VERSION, ...theme });
    const existing = await this.get(payload.id);
    if (existing) return existing;
    await this.artifacts.write(themePath(payload.id), `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  /** Themes in stable ID order, bounded. */
  async list(limit = 500): Promise<string[]> {
    return this.artifacts.list("themes", limit);
  }
}
