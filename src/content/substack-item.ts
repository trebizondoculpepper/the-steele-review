import { z } from "zod";

/**
 * Normalised metadata for one public Substack post, shared by every discovery
 * source (RSS, historical archive). It describes content identity only: event
 * identity (CloudEvents `id`, ingestion reason, correlation) lives in the event
 * envelope and must never be stored here.
 *
 * Identity rules:
 * - `publicationId` is the lower-case Substack subdomain, e.g. `example` for
 *   `https://example.substack.com/`.
 * - `postId` is the post's URL slug (`/p/<slug>`). The public RSS feed exposes
 *   no numeric post ID; its `guid` is the canonical post URL, so the slug is the
 *   most stable identifier available to every source. A source that cannot
 *   supply a slug must derive it from the canonical URL with
 *   {@link postIdFromCanonicalUrl}. Titles are never used as identity.
 * - Together, `publicationId` + `postId` form the content key used downstream
 *   for content-work deduplication.
 *
 * Dates are ISO 8601 strings with an explicit offset. A date the source does
 * not supply is omitted, never invented.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_POST_ID = 200;
const PUBLICATION = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const SubstackItemSchema = z
  .object({
    publicationId: z
      .string()
      .regex(PUBLICATION)
      .describe("Normalised publication identifier: the lower-case Substack subdomain."),
    postId: z
      .string()
      .min(1)
      .max(MAX_POST_ID)
      .regex(SLUG)
      .describe("Stable post identifier within the publication: the lower-case URL slug."),
    url: z
      .url({ protocol: /^https$/ })
      .regex(/^https:\/\//)
      .describe("Canonical public HTTPS URL of the post."),
    title: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/\S/)
      .describe("Post title as published. Informational only; never used as identity."),
    author: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Explicit source byline, when supplied; never inferred from publication identity."),
    publishedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("First publication time, when the source supplies it. Omitted if unknown."),
    updatedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Last update time, when the source supplies it. Omitted if unknown."),
  })
  .strict()
  .meta({
    title: "SubstackItem",
    description:
      "Normalised metadata for one public Substack post. Content identity only; no article body, media or event metadata.",
  });

export type SubstackItem = z.infer<typeof SubstackItemSchema>;

/** Invalid optional attribution must not discard an otherwise usable post. */
export function normalisePostAuthor(value: unknown): string | undefined {
  const parsed = SubstackItemSchema.shape.author.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Validate untrusted metadata, throwing a ZodError if it is malformed. */
export function parseSubstackItem(input: unknown): SubstackItem {
  return SubstackItemSchema.parse(input);
}

/** JSON Schema (draft 2020-12) for {@link SubstackItemSchema}; the field dictionary. */
export function substackItemJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(SubstackItemSchema) as Record<string, unknown>;
}

/**
 * Derive the post slug from a canonical `https://<host>/p/<slug>` URL, the
 * documented fallback when a source supplies no native identifier. Returns
 * undefined when the URL does not follow that shape.
 */
export function postIdFromCanonicalUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  const match = /^\/p\/([^/]+)\/?$/.exec(parsed.pathname);
  const slug = match?.[1]?.toLowerCase();
  return slug && slug.length <= MAX_POST_ID && SLUG.test(slug) ? slug : undefined;
}
