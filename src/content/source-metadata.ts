import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * Configured source attribution (#462).
 *
 * A subscribed source may name a default author explicitly. That is configured
 * attribution, not extraction inference: the extractor never guesses an author
 * from a publication id or a missing byline. An explicit personal post byline
 * wins, a multi-author byline stays unknown, and every resolved author carries
 * the basis it came from plus the configuration version, so a derived artifact
 * can record exactly what it relied on.
 */

export const SourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

export const SourceMetadataSchema = z
  .object({
    /** Stable source identity: the same source keeps this across ingesters. */
    sourceId: SourceIdSchema,
    /** Kind of source, e.g. "substack" or a fixture kind. */
    sourceType: z.string().min(1).max(40),
    /** Human-readable source name, never a credential or private URL. */
    displayName: z.string().trim().min(1).max(200),
    /** Exact configured publication/account labels, not person aliases or inferred names. */
    sourceAccountBylines: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    /** Used when a post has no personal byline, including a recognized source account. */
    defaultAuthor: z.string().trim().min(1).max(200).optional(),
    /**
     * Stable identity of the default author, so person resolution (#470/#471)
     * never relies on display-name equality across different sources.
     */
    defaultAuthorId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
      .optional(),
  })
  .strict();
export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;

export const SourceMetadataRegistrySchema = z
  .array(SourceMetadataSchema)
  .max(500)
  .superRefine((sources, ctx) => {
    const seen = new Map<string, number>();
    for (const [index, source] of sources.entries()) {
      const prior = seen.get(source.sourceId);
      if (prior !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `source ${source.sourceId} is configured twice (also at index ${prior})`,
          path: [index, "sourceId"],
        });
      } else seen.set(source.sourceId, index);
    }
  });

export interface ParsedSourceMetadata {
  /** Content-addressed identity of the configuration the resolution used. */
  version: string;
  bySource: ReadonlyMap<string, SourceMetadata>;
}

/**
 * Parse and validate the source registry. The version is a hash of the
 * canonical configuration, so changing any default changes the identity that
 * derived artifacts record.
 */
/**
 * The private configuration document (schema version 1): a revisioned list of
 * sources whose default author carries a stable id and a display name.
 */
const SourceDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().min(1),
    sources: z
      .array(
        z
          .object({
            id: SourceIdSchema,
            type: z.string().min(1).max(40),
            name: z.string().trim().min(1).max(200),
            sourceAccountBylines: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
            defaultAuthor: z
              .object({
                id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
                name: z.string().trim().min(1).max(200),
              })
              .strict()
              .optional(),
            /** Recorded as configured attribution; resolution reports `source-configured`. */
            attributionBasis: z.literal("owner-configured").optional(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

/** Accepts the versioned document or the earlier bare registry array. */
function normalise(input: unknown): SourceMetadata[] {
  if (Array.isArray(input)) return SourceMetadataRegistrySchema.parse(input);
  const doc = SourceDocumentSchema.parse(input);
  return SourceMetadataRegistrySchema.parse(
    doc.sources.map((s) => ({
      sourceId: s.id,
      sourceType: s.type,
      displayName: s.name,
      ...(s.sourceAccountBylines ? { sourceAccountBylines: s.sourceAccountBylines } : {}),
      ...(s.defaultAuthor
        ? { defaultAuthor: s.defaultAuthor.name, defaultAuthorId: s.defaultAuthor.id }
        : {}),
    })),
  );
}

export function parseSourceMetadata(input: unknown): ParsedSourceMetadata {
  const sources = normalise(input);
  const canonical = JSON.stringify(
    [...sources].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  );
  const version = `source-metadata-sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  return { version, bySource: new Map(sources.map((s) => [s.sourceId, s])) };
}

/** Why an author was attributed, or why none could be. */
export type AttributionBasis = "post-byline" | "source-configured";

export type PostAuthorResolution =
  | {
      status: "resolved";
      author: string;
      /** Stable configured identity, when the source records one. */
      authorId?: string;
      basis: AttributionBasis;
      /** Configuration version the resolution relied on. */
      sourceMetadataVersion: string;
    }
  | {
      status: "unknown";
      reason: "no-byline-no-default" | "ambiguous-byline";
      sourceMetadataVersion: string;
    };

const normalizedByline = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
function isSourceAccountByline(source: SourceMetadata | undefined, value: string): boolean {
  return (
    source?.sourceAccountBylines?.some(
      (alias) => normalizedByline(alias) === normalizedByline(value),
    ) ?? false
  );
}

/**
 * Resolve the author of an archived post.
 *
 * Precedence: an explicit single-person post byline, then the configured source
 * default. A multi-author byline is ambiguous and never collapses to the
 * default — that would silently attribute a co-written post to one person.
 */
export function resolvePostAuthor(input: {
  sourceId: string;
  metadata: ParsedSourceMetadata;
  /** Authors named by an explicit post byline, in source order. */
  byline?: readonly string[];
}): PostAuthorResolution {
  const version = input.metadata.version;
  const source = input.metadata.bySource.get(input.sourceId);
  if (input.byline && input.byline.length > 1)
    return { status: "unknown", reason: "ambiguous-byline", sourceMetadataVersion: version };
  const single = input.byline?.[0]?.trim();
  if (single && !isSourceAccountByline(source, single)) {
    return {
      status: "resolved",
      author: single,
      basis: "post-byline",
      sourceMetadataVersion: version,
    };
  }
  const configured = source?.defaultAuthor?.trim();
  if (configured) {
    return {
      status: "resolved",
      author: configured,
      ...(source?.defaultAuthorId ? { authorId: source.defaultAuthorId } : {}),
      basis: "source-configured",
      sourceMetadataVersion: version,
    };
  }
  return { status: "unknown", reason: "no-byline-no-default", sourceMetadataVersion: version };
}

/**
 * The author a claim's speaker may inherit.
 *
 * Only author-voice claims may take the resolved post author. A claim the post
 * explicitly attributes to somebody else (quoted, or an uncertain attribution)
 * keeps its own speaker and never inherits the post default.
 */
export function authorVoiceAuthor(
  speakerKind: "author-voice" | "quoted" | "unknown" | "uncertain",
  resolution: PostAuthorResolution,
): string | undefined {
  if (speakerKind !== "author-voice") return undefined;
  return resolution.status === "resolved" ? resolution.author : undefined;
}

/**
 * Attribution contribution to a derived-artifact or cache identity.
 *
 * Including this means an older un-attributed result is not silently reused
 * once a source default is configured, and a changed default produces a new
 * identity rather than relabelling old history in place.
 */
export function attributionIdentity(r: PostAuthorResolution): string {
  return r.status === "resolved"
    ? `${r.basis}:${r.authorId ? `${r.authorId}=` : ""}${r.author}:${r.sourceMetadataVersion}`
    : `unknown:${r.reason}:${r.sourceMetadataVersion}`;
}

/**
 * Load the source registry from a private configuration file.
 *
 * The path and contents are runtime configuration: validation errors name only
 * the failing field, never the configured values, so nothing private reaches a
 * log or an error response.
 */
export async function loadSourceMetadataFile(path: string): Promise<ParsedSourceMetadata> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new SourceMetadataError("unreadable-configuration");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SourceMetadataError("invalid-configuration");
  }
  try {
    return parseSourceMetadata(parsed);
  } catch {
    throw new SourceMetadataError("invalid-configuration");
  }
}

export class SourceMetadataError extends Error {
  constructor(readonly code: "unreadable-configuration" | "invalid-configuration") {
    super(`source metadata: ${code}`);
  }
}

/**
 * Authors named by a captured post's byline. Several names joined by "and",
 * "&" or commas are kept separate so the byline resolves as ambiguous rather
 * than collapsing to one person or to the source default.
 */
export function bylineAuthors(author: string | undefined): string[] | undefined {
  const text = author?.trim();
  if (!text) return undefined;
  return text
    .split(/\s+(?:and|&)\s+|\s*,\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * Source metadata named by `STEELE_SOURCE_METADATA_PATH`, or undefined when it
 * is not configured (extraction then records legacy, unconfigured
 * attribution). A configured but unreadable or invalid file is a startup
 * failure with a fixed category, never a silent fallback.
 */
export function sourceMetadataFromEnv(
  env: Record<string, string | undefined>,
): ParsedSourceMetadata | undefined {
  const path = env.STEELE_SOURCE_METADATA_PATH?.trim();
  if (!path) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new SourceMetadataError("unreadable-configuration");
  }
  try {
    return parseSourceMetadata(JSON.parse(raw));
  } catch {
    throw new SourceMetadataError("invalid-configuration");
  }
}

/**
 * Attribution for one captured post: its byline first, then the configured
 * default of its source (the publication id is the logical source id).
 * Undefined without configuration, so older behaviour and identities hold.
 */
export function postAttribution(
  metadata: ParsedSourceMetadata | undefined,
  post: { publicationId: string; author?: string },
): PostAuthorResolution | undefined {
  if (!metadata) return undefined;
  // Match the whole account label before splitting person lists: a publication
  // name may itself contain "and" or commas without naming multiple authors.
  const byline =
    post.author && isSourceAccountByline(metadata.bySource.get(post.publicationId), post.author)
      ? [post.author]
      : bylineAuthors(post.author);
  return resolvePostAuthor({
    sourceId: post.publicationId,
    metadata,
    ...(byline ? { byline } : {}),
  });
}
