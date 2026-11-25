import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";

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
 *
 * Each mapping is an ordinary JSON document at a stable path, created once
 * and corrected by a normal Git revision of the same file, with an
 * expected-version check (owner design, #518). Git is the history: there is no
 * separate supersession journal. Coverage pins the exact mapping version it
 * used, so an earlier brief keeps reading its original bytes after a
 * correction while current lookups see the new content.
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
export function proposalMappingKey(
  proposal: string,
  description?: string,
): string {
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
    decidedBy: z
      .object({ publicationId: z.string(), postId: z.string() })
      .strict(),
    rationale: z.string().min(1).max(1000),
    /** How the decision was made (#518 provenance); absent on older mappings. */
    method: z.enum(["embedding", "lexical", "manual"]).optional(),
    /** The saved proposal the decision was made from. */
    source: z
      .object({
        themeResult: z
          .object({
            repository: z.string(),
            commit: z.string(),
            path: z.string(),
            hash: z.string(),
          })
          .strict(),
        proposalId: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    /**
     * Set by a correction when a split or changed meaning needs a new choice:
     * the mapping is then not reused, and the proposal goes back through the
     * bounded shortlist/decision path instead of a silent guess.
     */
    status: z.literal("unresolved").optional(),
    /** The latest correction, when the file has been revised. */
    correction: z
      .object({
        reason: z.string().min(1).max(1000),
        correctedAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .optional(),
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
export function themeMappingPath(
  m: Pick<ThemeMapping, "key" | "scope">,
): string {
  const scope =
    m.scope === undefined
      ? "global"
      : `scope-${pathSegment(normaliseMappingKey(m.scope))}`;
  return `librarian/theme-mappings/${scope}/${pathSegment(normaliseMappingKey(m.key))}.json`;
}

export interface ThemeMappingQuery {
  proposal: string;
  description?: string;
  scope?: string;
}

/** A mapping together with the exact version it was read from. */
export interface PinnedThemeMapping {
  mapping: ThemeMapping;
  ref: ArtifactRef;
}

const serialise = (m: ThemeMapping) => `${JSON.stringify(m, null, 2)}\n`;

/**
 * Consult saved mappings. A scope-specific decision wins over a global one for
 * the same proposal; nothing is guessed when neither exists. Wording and
 * description together form the key, so a same-titled topic with a different
 * meaning never inherits another's decision.
 */
export class ThemeMappingCatalogue {
  constructor(
    private readonly artifacts: Pick<
      GitArtifactStore,
      "lookup" | "read" | "revise" | "list"
    >,
  ) {}

  /** Complete bounded title lookup; an incomplete catalogue is never reported as absence. */
  async titleCandidates(title: string): Promise<PinnedThemeMapping[]> {
    const out: PinnedThemeMapping[] = [];
    let count = 0;
    for (let after: string | undefined; ;) {
      const page = await this.artifacts.list(
        "librarian/theme-mappings",
        1000,
        after,
      );
      count += page.length;
      if (count > 20000) throw new Error("theme-title-catalogue-limit");
      for (const path of page) {
        const ref = await this.artifacts.lookup(path);
        if (!ref) throw new Error("theme-title-catalogue-changed");
        const mapping = ThemeMappingSchema.parse(
          JSON.parse(await this.artifacts.read(ref)),
        );
        if (themeMappingPath(mapping) !== path)
          throw new Error("theme-title-catalogue-mismatch");
        if (
          normaliseMappingKey(mapping.proposal) === normaliseMappingKey(title)
        )
          out.push({ mapping, ref });
      }
      if (page.length < 1000) return out;
      after = page[page.length - 1];
    }
  }

  /** The current mapping, or undefined; an unresolved mapping is never reused. */
  async lookup(query: ThemeMappingQuery): Promise<ThemeMapping | undefined> {
    return (await this.current(query))?.mapping;
  }

  /** The current, reusable mapping with its exact version, for pinning. */
  async current(
    query: ThemeMappingQuery,
  ): Promise<PinnedThemeMapping | undefined> {
    const key = proposalMappingKey(query.proposal, query.description);
    const candidates: Array<Pick<ThemeMapping, "key" | "scope">> = [];
    if (query.scope !== undefined) candidates.push({ key, scope: query.scope });
    candidates.push({ key });
    for (const candidate of candidates) {
      const found = await this.at(themeMappingPath(candidate));
      if (!found) continue;
      if (found.mapping.status === "unresolved") return undefined;
      return found;
    }
    return undefined;
  }

  /** Exactly the pinned version a brief used, even after later corrections. */
  async pinned(ref: ArtifactRef): Promise<ThemeMapping> {
    return ThemeMappingSchema.parse(JSON.parse(await this.artifacts.read(ref)));
  }

  private async at(path: string): Promise<PinnedThemeMapping | undefined> {
    const ref = await this.artifacts.lookup(path);
    if (!ref) return undefined;
    const parsed = ThemeMappingSchema.safeParse(
      JSON.parse(await this.artifacts.read(ref)),
    );
    return parsed.success ? { mapping: parsed.data, ref } : undefined;
  }

  /**
   * Record a new decision. The first accepted decision for a key and scope
   * wins: a concurrent or repeated record returns the stored one rather than
   * overwriting it. Changing a stored decision is a `correct`, never a record.
   */
  async record(
    mapping: Omit<ThemeMapping, "schemaVersion" | "key">,
  ): Promise<ThemeMapping> {
    return (await this.recordPinned(mapping)).mapping;
  }

  async recordPinned(
    mapping: Omit<ThemeMapping, "schemaVersion" | "key">,
  ): Promise<PinnedThemeMapping> {
    const key = proposalMappingKey(mapping.proposal, mapping.description);
    if (key.length === 0) throw new Error("theme mapping: empty proposal");
    const payload = ThemeMappingSchema.parse({
      schemaVersion: THEME_MAPPING_SCHEMA_VERSION,
      key,
      ...mapping,
    });
    const path = themeMappingPath(payload);
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.at(path);
      // A resolved decision is authoritative and never overwritten here.
      if (existing && existing.mapping.status !== "unresolved") return existing;
      try {
        // Create only if absent; an unresolved mapping is resolved by this
        // fresh accepted decision as a revision checked against its version.
        const ref = await this.artifacts.revise(
          path,
          serialise(payload),
          existing ? existing.ref.sha256 : null,
        );
        return { mapping: payload, ref };
      } catch (error) {
        // Someone else changed the file first: re-read and decide again.
        if (
          error instanceof ArtifactStoreError &&
          error.code === "stale-revision"
        )
          continue;
        throw error;
      }
    }
    const winner = await this.at(path);
    if (winner && winner.mapping.status !== "unresolved") return winner;
    throw new Error("theme mapping: could not record a decision");
  }

  /**
   * Correct a mapping as a normal revision of its file. The caller names the
   * version it read; if the file changed since, `stale-revision` is thrown
   * and nothing is overwritten. A rename of the canonical display name needs
   * no correction: the theme ID is stable.
   */
  async correct(input: {
    expected: ArtifactRef;
    change:
      | { canonicalThemeId: string; unresolved?: never }
      | { unresolved: true; canonicalThemeId?: never };
    reason: string;
    correctedAt: string;
  }): Promise<PinnedThemeMapping> {
    const current = await this.pinned(input.expected);
    const next = ThemeMappingSchema.parse({
      ...current,
      ...(input.change.unresolved
        ? { status: "unresolved" as const }
        : {
            canonicalThemeId: input.change.canonicalThemeId,
            status: undefined,
          }),
      method: "manual",
      correction: { reason: input.reason, correctedAt: input.correctedAt },
    });
    if (next.status === undefined) delete (next as { status?: unknown }).status;
    const ref = await this.artifacts.revise(
      input.expected.path,
      serialise(next),
      input.expected.sha256,
    );
    return { mapping: next, ref };
  }
}
