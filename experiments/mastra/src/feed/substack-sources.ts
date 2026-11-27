import { z } from "zod";

import { declaredKeys, sanitizeIssues, type ConfigReader, type ConfigSection } from "../common/config/index.js";

/**
 * The Substack poller's view of the source configuration (#945, used by #943).
 *
 * The poller owns this schema; the shared configuration layer only reads the
 * file. It reads the existing source registry, `sources/sources.json` under
 * the configuration root, in either of its existing formats:
 *
 * - the versioned document `{schemaVersion: 1, revision, sources: [{id, type, name, ...}]}`;
 * - the earlier bare array `[{sourceId, sourceType, displayName, ...}]`.
 *
 * The same file also carries settings owned by other consumers (author
 * attribution, bylines). The poller validates only the fields it uses and
 * leaves the others alone, so it neither rejects nor rewrites them.
 *
 * Two optional fields are the poller's own additions; existing files stay
 * valid without them:
 * - `enabled` (default true): false keeps a source configured but unpolled;
 * - `feedUrl` (default `https://<id>.substack.com/feed`): an https URL, for a
 *   publication on a custom domain.
 */

export const SOURCES_FILE = "sources/sources.json";

/** Same identity rule as the earlier source registry. */
const SourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/, "must be a source id (letters, digits, '.', '_' or '-')");

const FeedUrl = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "must be an https URL without credentials");

const PollerFields = {
  enabled: z.boolean().optional(),
  feedUrl: FeedUrl.optional(),
};

const DocumentEntry = z.looseObject({
  id: SourceId,
  type: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  ...PollerFields,
});

const LegacyEntry = z.looseObject({
  sourceId: SourceId,
  sourceType: z.string().min(1).max(40),
  displayName: z.string().trim().min(1).max(200),
  ...PollerFields,
});

interface Entry {
  id: string;
  type: string;
  name: string;
  enabled?: boolean;
  feedUrl?: string;
}

const DocumentRegistry = z
  .looseObject({
    schemaVersion: z.literal(1),
    revision: z.number().int().min(1),
    sources: z.array(DocumentEntry).max(500),
  })
  .transform((doc): { entries: Entry[]; at: PropertyKey[] } => ({ entries: doc.sources, at: ["sources"] }));

const LegacyRegistry = z
  .array(LegacyEntry)
  .max(500)
  .transform((rows): { entries: Entry[]; at: PropertyKey[] } => ({
    entries: rows.map((r) => ({ id: r.sourceId, type: r.sourceType, name: r.displayName, enabled: r.enabled, feedUrl: r.feedUrl })),
    at: [],
  }));

/** Either registry format; the format is chosen by shape so errors describe that format, not both. */
const Registry = z.unknown().transform((input, ctx): Entry[] => {
  const format = Array.isArray(input) ? LegacyRegistry : DocumentRegistry;
  const result = format.safeParse(input);
  if (!result.success) {
    // Re-raise with value-free descriptions; the shared layer redacts undeclared path keys.
    const safe = sanitizeIssues(result.error.issues, format);
    result.error.issues.forEach((issue, i) => ctx.addIssue({ code: "custom", path: issue.path, message: safe[i]!.message }));
    return z.NEVER;
  }
  const { entries, at } = result.data;
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const prior = seen.get(entry.id);
    if (prior === undefined) seen.set(entry.id, index);
    else ctx.addIssue({ code: "custom", path: [...at, index, "id"], message: `duplicate source id (also at index ${prior})` });
  });
  return entries;
});

/** One Substack publication the poller should poll. */
export interface SubstackFeed {
  sourceId: string;
  name: string;
  feedUrl: string;
  /** Host of the feed, used to recognise the publication's own post links. */
  publicationHost: string;
}

export const SubstackFeedsSection: ConfigSection<SubstackFeed[]> = {
  file: SOURCES_FILE,
  // The registry schemas run inside a transform, so their keys are listed for error paths.
  keys: [...declaredKeys(DocumentRegistry), ...declaredKeys(LegacyRegistry)],
  schema: Registry.transform((entries) =>
    entries
      .filter((entry) => entry.type === "substack" && entry.enabled !== false)
      .map((entry) => {
        const feedUrl = entry.feedUrl ?? `https://${entry.id.toLowerCase()}.substack.com/feed`;
        return { sourceId: entry.id, name: entry.name, feedUrl, publicationHost: new URL(feedUrl).host };
      }),
  ),
};

/** The enabled Substack feeds, read fresh from the configuration on each call. */
export function enabledSubstackFeeds(config: ConfigReader): Promise<SubstackFeed[]> {
  return config.read(SubstackFeedsSection);
}
