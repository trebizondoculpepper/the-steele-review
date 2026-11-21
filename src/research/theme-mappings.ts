import { z } from "zod";
import type { GitArtifactStore } from "../controllers/artifact-store.js";

/**
 * First-class, reusable theme mappings (#518).
 *
 * The librarian's per-post coverage record only reuses decisions when the exact
 * theme and claim results match, so an identical proposal assessed on another
 * post is re-derived from scratch. This catalogue persists the decision once,
 * keyed by normalised proposal text and optional scope, as a versioned corpus
 * artifact that any later assessment can consult.
 *
 * A catalogue hit is a decision that was already made by the librarian; it is
 * never a fresh judgement and never an inference by the extractor.
 */

export const THEME_MAPPING_SCHEMA_VERSION = 1;

/** Normalise a proposal label or scope for stable, reusable keys. */
export function normaliseMappingKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export const ThemeMappingSchema = z
  .object({
    schemaVersion: z.literal(THEME_MAPPING_SCHEMA_VERSION),
    /** Normalised proposal text the librarian recognised. */
    key: z.string().min(1).max(300),
    /** The proposal wording exactly as assessed, for review. */
    proposal: z.string().min(1).max(300),
    /** Optional scope, e.g. a publication or programme, when the decision was scoped. */
    scope: z.string().min(1).max(120).optional(),
    /** Stable canonical research topic / dossier the proposal maps to. */
    canonicalThemeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    decidedAt: z.iso.datetime({ offset: true }),
    /** Where the decision was first made. */
    decidedBy: z.object({ publicationId: z.string(), postId: z.string() }).strict(),
    rationale: z.string().min(1).max(1000),
  })
  .strict();
export type ThemeMapping = z.infer<typeof ThemeMappingSchema>;

/** Stable artifact path for one mapping, including its optional scope. */
export function themeMappingPath(m: Pick<ThemeMapping, "key" | "scope">): string {
  const scope = m.scope === undefined ? "global" : `scope-${normaliseMappingKey(m.scope).replace(/ /g, "-")}`;
  return `librarian/theme-mappings/${scope}/${normaliseMappingKey(m.key).replace(/ /g, "-")}.json`;
}

export interface ThemeMappingQuery {
  proposal: string;
  scope?: string;
}

/**
 * Consult saved mappings. A scope-specific decision wins over a global one for
 * the same proposal; nothing is guessed when neither exists.
 */
export class ThemeMappingCatalogue {
  constructor(private readonly artifacts: Pick<GitArtifactStore, "lookup" | "read" | "write">) {}

  async lookup(query: ThemeMappingQuery): Promise<ThemeMapping | undefined> {
    const key = normaliseMappingKey(query.proposal);
    const candidates: Array<Pick<ThemeMapping, "key" | "scope">> = [];
    if (query.scope !== undefined) candidates.push({ key, scope: query.scope });
    candidates.push({ key });
    for (const candidate of candidates) {
      const ref = await this.artifacts.lookup(themeMappingPath(candidate));
      if (!ref) continue;
      const parsed = ThemeMappingSchema.safeParse(JSON.parse(await this.artifacts.read(ref)));
      if (parsed.success) return parsed.data;
    }
    return undefined;
  }

  /**
   * Record a decision. Write-once: recording the same key and scope again keeps
   * the first decision, so history is never silently rewritten.
   */
  async record(mapping: Omit<ThemeMapping, "schemaVersion" | "key">): Promise<ThemeMapping> {
    const key = normaliseMappingKey(mapping.proposal);
    if (key.length === 0) throw new Error("theme mapping: empty proposal");
    const payload = ThemeMappingSchema.parse({
      schemaVersion: THEME_MAPPING_SCHEMA_VERSION,
      key,
      ...mapping,
    });
    const path = themeMappingPath(payload);
    const existing = await this.artifacts.lookup(path);
    if (existing) {
      const parsed = ThemeMappingSchema.safeParse(JSON.parse(await this.artifacts.read(existing)));
      if (parsed.success) return parsed.data;
    }
    await this.artifacts.write(path, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
}
