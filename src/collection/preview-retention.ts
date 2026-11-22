import { createHash } from "node:crypto";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { IMAGE_EXTENSIONS, type RetainedImageType } from "../controllers/research-web.js";
import type { CollectionRecord } from "./collection-store.js";

/** Fetches one eligible public image; refusals and failures throw. */
export interface ImageFetcherPort {
  fetch(
    url: string,
    signal: AbortSignal,
  ): Promise<{ bytes: Buffer; contentType: RetainedImageType }>;
}

export type PreviewRetentionOutcome = "retained" | "no-preview" | "already-retained" | "failed";

/**
 * Retain the post's eligible preview image beside its capture (#277): fetch
 * it through the bounded public fetcher, save the exact bytes as a binary
 * artifact at `substack/<pub>/<post>/images/<sha256>.<ext>` (content-
 * addressed, so a retry or an unchanged image reuses it), and only then add
 * the pinned reference to the record. A refused or failed fetch leaves the
 * record unchanged, never with a dangling reference, and never blocks it.
 * Eligibility (no generic art, logos or explicit covers) is decided upstream
 * when `previewImage` is derived; nothing here interprets image content.
 */
export async function retainPreviewImage(
  record: CollectionRecord,
  deps: {
    fetcher: ImageFetcherPort;
    artifacts: Pick<GitArtifactStore, "writeBinary">;
    signal: AbortSignal;
  },
): Promise<{ record: CollectionRecord; outcome: PreviewRetentionOutcome }> {
  const preview = record.previewImage;
  if (!preview) return { record, outcome: "no-preview" };
  if (preview.retained) return { record, outcome: "already-retained" };
  try {
    const { bytes, contentType } = await deps.fetcher.fetch(preview.url, deps.signal);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = `substack/${record.item.publicationId}/${record.item.postId}/images/${digest}.${IMAGE_EXTENSIONS[contentType]}`;
    const ref = await deps.artifacts.writeBinary(path, bytes, digest);
    return {
      record: {
        ...record,
        previewImage: {
          ...preview,
          retained: {
            artifact: {
              repository: ref.repository,
              commit: ref.commit,
              path: ref.path,
              hash: `sha256:${ref.sha256}`,
            },
            contentType,
            bytes: bytes.length,
          },
        },
      },
      outcome: "retained",
    };
  } catch {
    return { record, outcome: "failed" };
  }
}
