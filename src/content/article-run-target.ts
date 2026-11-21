import { createHash } from "node:crypto";

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const slugFor = (raw: string): string => {
  if (SLUG.test(raw)) return raw;
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 150);
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${base || "item"}-${hash}`;
};

/**
 * Work identity for a captured item. Substack keeps its publication and post
 * IDs, so a run started from a captured-content event and a replay from the
 * CLI share one workflow key. Other sources are prefixed with their kind
 * and suffixed with a hash of the whole namespace
 * (`blog/example-site` becomes `blog-example-site-<hash>`), so they cannot
 * collide with a Substack publication or with each other; item IDs outside the slug alphabet get a
 * stable hash suffix.
 */
export function articleRunTarget(namespace: string, itemId: string) {
  const [kind, instance] = namespace.split("/") as [string, string];
  const substack = kind === "substack";
  return {
    publicationId: substack
      ? instance
      : // The namespace hash keeps `blog/x` and `substack/blog-x` apart.
        `${`${kind}-${instance}`.slice(0, 180)}-${createHash("sha256").update(namespace).digest("hex").slice(0, 12)}`,
    // Substack keeps its post IDs so a captured-content run and a CLI replay
    // share one key. Every other source is encoded, and always with a hash, so
    // an encoded ID can never equal an item ID that needed no encoding:
    // `2026-11-20_a.post` and `2026-11-20-a-post-<hash>` stay distinct.
    postId: substack
      ? itemId
      : SLUG.test(itemId)
        ? // A raw ID that is already slug-safe would otherwise pass through
          // unchanged and equal an encoded ID. Encoding always adds a hash,
          // and the base is bounded so the result stays within the 200
          // character limit ArticleRunInputSchema enforces.
          `${itemId.slice(0, 180)}-${createHash("sha256").update(itemId).digest("hex").slice(0, 12)}`
        : slugFor(itemId),
  };
}
