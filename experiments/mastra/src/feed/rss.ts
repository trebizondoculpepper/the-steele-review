import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";

/**
 * RSS discovery for one allowed Substack publication (#919). Pure parsing and
 * normalisation: no storage, no fetching of posts, no writing.
 *
 * Identity: the RSS item does not carry Substack's numeric post ID for text
 * posts, but audio posts' enclosure URL does (`/feed/podcast/<postId>/…`).
 * The discovery key is therefore the canonical post URL. The post ID is
 * recorded when the feed reveals it, and capture (#920) pins the definitive
 * source item ID from the post endpoint.
 */

export interface FeedItem {
  /** Canonical `https://<publication host>/p/<slug>`; the discovery key. */
  canonicalUrl: string;
  slug: string;
  /** Numeric post ID when the feed reveals it, else null. */
  postId: string | null;
  /** `substack:<publication>:<postId>` when known, per the contract. */
  sourceItem: string | null;
  title: string;
  publishedAt: string | null;
  medium: "audio" | "video" | "written" | "unknown";
  /** Hash of the observed item metadata; a change means the item was edited. */
  fingerprint: string;
}

export class FeedError extends Error {
  readonly code: "invalid-feed" | "wrong-publication";
  constructor(code: "invalid-feed" | "wrong-publication", message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const Text = z.union([z.string(), z.number()]).transform(String);
const Item = z.looseObject({
  title: Text.optional(),
  link: Text,
  guid: z.union([Text, z.looseObject({ "#text": Text })]).optional(),
  pubDate: Text.optional(),
  enclosure: z.looseObject({ "@_url": z.string().optional(), "@_type": z.string().optional() }).optional(),
  description: Text.optional(),
  "content:encoded": Text.optional(),
});
const Feed = z.looseObject({
  rss: z.looseObject({
    channel: z.looseObject({ item: z.union([Item, z.array(Item)]).optional() }),
  }),
});

/** A larger feed is refused rather than truncated, so a baseline never silently omits items. */
const MAX_ITEMS = 500;

export function parseFeed(xml: string, publicationHost: string): FeedItem[] {
  if (xml.length > 5_000_000) throw new FeedError("invalid-feed", "feed is too large");
  // Reject truncated or malformed documents before parsing: a lenient parse
  // of a partial response must never establish the baseline.
  if (XMLValidator.validate(xml) !== true) throw new FeedError("invalid-feed", "not well-formed XML");
  let doc: unknown;
  try {
    doc = new XMLParser({ ignoreAttributes: false, processEntities: true, htmlEntities: true }).parse(xml);
  } catch {
    throw new FeedError("invalid-feed", "not well-formed XML");
  }
  const parsed = Feed.safeParse(doc);
  if (!parsed.success) throw new FeedError("invalid-feed", "not an RSS channel");
  const raw = parsed.data.rss.channel.item;
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const publication = publicationHost.split(".")[0]!;
  if (items.length > MAX_ITEMS) throw new FeedError("invalid-feed", `feed has more than ${MAX_ITEMS} items`);
  return items.map((it) => {
    const url = canonicalPostUrl(it.link, publicationHost);
    const slug = url.pathname.slice(3);
    const enclosureUrl = it.enclosure?.["@_url"] ?? "";
    const postId = /^https:\/\/api\.substack\.com\/feed\/podcast\/(\d{1,15})\//.exec(enclosureUrl)?.[1] ?? null;
    const type = it.enclosure?.["@_type"] ?? "";
    const medium = type.startsWith("audio/") ? "audio" : type.startsWith("video/") ? "video" : it.enclosure ? "unknown" : "written";
    const published = it.pubDate ? new Date(it.pubDate) : null;
    const item = {
      canonicalUrl: url.href,
      slug,
      postId,
      sourceItem: postId ? `substack:${publication}:${postId}` : null,
      title: (it.title ?? "").trim().slice(0, 500),
      publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
      medium,
    } as const;
    const fingerprint = `sha256:${createHash("sha256")
      .update(
        JSON.stringify([item.canonicalUrl, item.postId, item.title, item.publishedAt, item.medium, enclosureUrl, it.description ?? "", it["content:encoded"] ?? ""]),
      )
      .digest("hex")}`;
    return { ...item, fingerprint };
  });
}

/** Validates a post URL on the allowed publication and returns its canonical form. */
export function canonicalPostUrl(link: string, publicationHost: string): URL {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new FeedError("invalid-feed", "item link is not a URL");
  }
  const slug = /^\/p\/([a-z0-9-]{1,200})\/?$/.exec(url.pathname)?.[1];
  if (url.protocol !== "https:" || url.hostname !== publicationHost || url.username || url.password || !slug)
    throw new FeedError("wrong-publication", "item is not a post on the allowed publication");
  return new URL(`https://${publicationHost}/p/${slug}`);
}
