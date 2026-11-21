import { createHash } from "node:crypto";

/** Stable across redelivery and revisions of the original post. */
export function postCorrelationId(post: { publicationId: string; postId: string }): string {
  return `post-${createHash("sha256")
    .update(JSON.stringify([post.publicationId, post.postId]))
    .digest("hex")}`;
}
