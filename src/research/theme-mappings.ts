import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactStoreError, type GitArtifactStore } from "../controllers/artifact-store.js";

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
  return fold(text);
}

function fold(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Key for a proposal. The description is part of the key: "Mercury" the planet
 * and "Mercury" the toxic metal must not share a canonical mapping.
 */
export function proposalMappingKey(proposal: string, description?: string): string {
  return fold(`${proposal} ${fold(description ?? "")}`.trim());
}

export const ThemeMappingSchema = z
  .object({
    schemaVersion: z.literal(THEME_MAPPING_SCHEMA_VERSION),
    /** Normalised proposal text the librarian recognised. */
    key: z.string().min(1).max(2400),
    /** The proposal wording exactly as assessed, for review. */
    proposal: z.string().min(1).max(300),
    /** The proposal description, which separates same-titled different topics. */
    /** Proposals allow descriptions up to 2000 characters (theme-proposals). */
    description: z.string().max(2000).optional(),
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

/**
 * Artifact-safe path segment: ASCII letters, digits and dashes only, with a
 * short hash so distinct keys (including non-ASCII ones like "El Niño") can
 * never share a file or produce an invalid path.
 */
function pathSegment(text: string): string {
  const slug = text
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    // Keep ASCII only: the artifact store rejects non-ASCII path segments.
    .replace(/[^A-Za-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `${slug || "entry"}-${digest}`;
}

/** Stable artifact path for one mapping, including its optional scope. */
export function themeMappingPath(m: Pick<ThemeMapping, "key" | "scope">): string {
  const scope = m.scope === undefined ? "global" : `scope-${pathSegment(normaliseMappingKey(m.scope))}`;
  return `librarian/theme-mappings/${scope}/${pathSegment(normaliseMappingKey(m.key))}.json`;
}

export const THEME_MAPPING_SUPERSESSION_SCHEMA_VERSION = 1;

/**
 * Explicit supersession of one mapping decision (#518).
 *
 * A canonical split, merge or changed scope is recorded as an immutable
 * redirect from the old canonical ID to the new one. Earlier mapping versions
 * and the briefs that referenced them stay untouched; only new lookups follow
 * the redirect.
 */
export const ThemeMappingSupersessionSchema = z
  .object({
    schemaVersion: z.literal(THEME_MAPPING_SUPERSESSION_SCHEMA_VERSION),
    key: z.string().min(1).max(2400),
    scope: z.string().min(1).max(120).optional(),
    from: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    to: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    reason: z.string().min(1).max(1000),
    decidedAt: z.iso.datetime({ offset: true }),
    decidedBy: z.object({ publicationId: z.string(), postId: z.string() }).strict(),
  })
  .strict();
export type ThemeMappingSupersession = z.infer<typeof ThemeMappingSupersessionSchema>;

/** Immutable artifact path for one supersession event. */
export function themeMappingSupersessionPath(
  s: Pick<ThemeMappingSupersession, "key" | "scope" | "from" | "to" | "decidedAt">,
): string {
  const scope = s.scope === undefined ? "global" : `scope-${pathSegment(normaliseMappingKey(s.scope))}`;
  const name = `${s.from}-to-${s.to}-${createHash("sha256")
    .update(`${s.decidedAt}|${s.from}|${s.to}`)
    .digest("hex")
    .slice(0, 12)}`;
  return `librarian/theme-mappings/supersessions/${scope}/${pathSegment(normaliseMappingKey(s.key))}/${name}.json`;
}

export interface ThemeMappingQuery {
  proposal: string;
  description?: string;
  scope?: string;
}

/**
 * Consult saved mappings. A scope-specific decision wins over a global one for
 * the same proposal; nothing is guessed when neither exists.
 */
export class ThemeMappingCatalogue {
  constructor(
    private readonly artifacts: Pick<GitArtifactStore, "lookup" | "read" | "write" | "list">,
  ) {}

  async lookup(query: ThemeMappingQuery): Promise<ThemeMapping | undefined> {
    const key = proposalMappingKey(query.proposal, query.description);
    const candidates: Array<Pick<ThemeMapping, "key" | "scope">> = [];
    if (query.scope !== undefined) candidates.push({ key, scope: query.scope });
    candidates.push({ key });
    for (const candidate of candidates) {
      const ref = await this.artifacts.lookup(themeMappingPath(candidate));
      if (!ref) continue;
      const parsed = ThemeMappingSchema.safeParse(JSON.parse(await this.artifacts.read(ref)));
      if (!parsed.success) continue;
      const canonicalThemeId = await this.resolve(parsed.data);
      return canonicalThemeId === parsed.data.canonicalThemeId
        ? parsed.data
        : { ...parsed.data, canonicalThemeId };
    }
    return undefined;
  }

  /** Follow saved supersessions to the current canonical ID (cycle-safe). */
  private async resolve(mapping: ThemeMapping): Promise<string> {
    const supersessions = await this.supersessions(mapping);
    let current = mapping.canonicalThemeId;
    const seen = new Set([current]);
    for (let hops = 0; hops < 20; hops++) {
      // The latest event from the current ID wins; ties keep the earlier event.
      const next = supersessions.find((s) => s.from === current);
      if (!next || seen.has(next.to)) return current;
      seen.add(next.to);
      current = next.to;
    }
    return current;
  }

  /** All recorded supersessions for one mapping, oldest first. */
  async supersessions(
    mapping: Pick<ThemeMapping, "key" | "scope">,
  ): Promise<ThemeMappingSupersession[]> {
    const scope = mapping.scope === undefined
      ? "global"
      : `scope-${pathSegment(normaliseMappingKey(mapping.scope))}`;
    const base = `librarian/theme-mappings/supersessions/${scope}/${pathSegment(normaliseMappingKey(mapping.key))}`;
    let paths: string[];
    try {
      paths = await this.listPrefix(base);
    } catch {
      return [];
    }
    const found: ThemeMappingSupersession[] = [];
    for (const path of paths.sort()) {
      try {
        const ref = await this.artifacts.lookup(path);
        if (!ref) continue;
        const parsed = ThemeMappingSupersessionSchema.safeParse(
          JSON.parse(await this.artifacts.read(ref)),
        );
        if (parsed.success) found.push(parsed.data);
      } catch {
        // An unreadable supersession is never guessed.
      }
    }
    // Stable chronological order; equal timestamps keep path order.
    return found.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  }

  /**
   * Record an explicit supersession. Write-once and idempotent: the first
   * event for the same key, scope and from/to pair wins.
   */
  async supersede(input: {
    proposal: string;
    description?: string;
    scope?: string;
    from: string;
    to: string;
    reason: string;
    decidedAt: string;
    decidedBy: { publicationId: string; postId: string };
  }): Promise<ThemeMappingSupersession> {
    const key = proposalMappingKey(input.proposal, input.description);
    if (key.length === 0) throw new Error("theme mapping: empty proposal");
    if (input.from === input.to) throw new Error("theme mapping: supersession is a no-op");
    const payload = ThemeMappingSupersessionSchema.parse({
      schemaVersion: THEME_MAPPING_SUPERSESSION_SCHEMA_VERSION,
      key,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      from: input.from,
      to: input.to,
      reason: input.reason,
      decidedAt: input.decidedAt,
      decidedBy: input.decidedBy,
    });
    const path = themeMappingSupersessionPath(payload);
    const read = async (): Promise<ThemeMappingSupersession | undefined> => {
      const ref = await this.artifacts.lookup(path);
      if (!ref) return undefined;
      const parsed = ThemeMappingSupersessionSchema.safeParse(
        JSON.parse(await this.artifacts.read(ref)),
      );
      return parsed.success ? parsed.data : undefined;
    };
    const existing = await read();
    if (existing) return existing;
    try {
      await this.artifacts.write(path, `${JSON.stringify(payload, null, 2)}\n`);
      return payload;
    } catch (error) {
      if (error instanceof ArtifactStoreError && error.code === "immutable-conflict") {
        const winner = await read();
        if (winner) return winner;
      }
      throw error;
    }
  }

  private async listPrefix(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const paths = await this.artifacts.list(prefix, 200, after);
      out.push(...paths);
      if (paths.length < 200) break;
      after = paths[paths.length - 1];
    }
    return out;
  }

  /**
   * Record a decision. Write-once: recording the same key and scope again keeps
   * the first decision, so history is never silently rewritten.
   */
  async record(mapping: Omit<ThemeMapping, "schemaVersion" | "key">): Promise<ThemeMapping> {
    const key = proposalMappingKey(mapping.proposal, mapping.description);
    if (key.length === 0) throw new Error("theme mapping: empty proposal");
    const payload = ThemeMappingSchema.parse({
      schemaVersion: THEME_MAPPING_SCHEMA_VERSION,
      key,
      ...mapping,
    });
    const path = themeMappingPath(payload);
    const read = async (): Promise<ThemeMapping | undefined> => {
      const ref = await this.artifacts.lookup(path);
      if (!ref) return undefined;
      const parsed = ThemeMappingSchema.safeParse(JSON.parse(await this.artifacts.read(ref)));
      return parsed.success ? parsed.data : undefined;
    };
    const existing = await read();
    if (existing) return existing;
    try {
      await this.artifacts.write(path, `${JSON.stringify(payload, null, 2)}\n`);
      return payload;
    } catch (error) {
      // A concurrent assessment may have written the same key first. The
      // stored winner is authoritative, so reconcile to it instead of failing.
      if (error instanceof ArtifactStoreError && error.code === "immutable-conflict") {
        const winner = await read();
        if (winner) return winner;
      }
      throw error;
    }
  }
}
