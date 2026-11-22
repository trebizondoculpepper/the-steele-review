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

/** Bounds on embedded-image retention per capture (#277). */
export const MAX_EMBEDDED_IMAGES = 20;
export const MAX_EMBEDDED_BYTES = 30 * 1024 * 1024;
export const EMBEDDED_DEADLINE_MS = 60_000;
/** Substack's generic podcast art is never post-specific. */
const GENERIC_ART = "https://substack.com/img/podcast/generic.png";
const IMAGE_LINK = /\.(png|jpe?g|gif|webp)(\?[^#]*)?$/i;

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

function attribute(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]{0,4000})"|'([^']{0,4000})')`, "i").exec(tag);
  const raw = m?.[2] ?? m?.[3];
  return raw === undefined ? undefined : decodeEntities(raw).trim();
}

/**
 * Image candidates in a captured article, in document order: `<img>` sources
 * with their alt text, and links that point straight at an image file.
 * HTTPS only; generic art is skipped. Tag-by-tag scan with bounded,
 * non-backtracking patterns; nothing is rendered or interpreted.
 */
export function embeddedImageCandidates(html: string): { url: string; alt?: string }[] {
  const out: { url: string; alt?: string }[] = [];
  for (const m of html.matchAll(/<(img|a)\b[^>]{0,8000}>/gi)) {
    const tag = m[0];
    const isImg = m[1]!.toLowerCase() === "img";
    const url = attribute(tag, isImg ? "src" : "href");
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
    if (parsed.href === GENERIC_ART) continue;
    if (!isImg && !IMAGE_LINK.test(parsed.pathname)) continue;
    const alt = isImg ? attribute(tag, "alt") : undefined;
    out.push({ url: parsed.href, ...(alt ? { alt: alt.slice(0, 1000) } : {}) });
  }
  return out;
}

export interface EmbeddedRetentionReport {
  retained: number;
  failed: number;
  truncated: boolean;
}

/**
 * Retain the images embedded in or linked from the captured article (#277),
 * after the thumbnail. Each distinct URL is fetched once (bounded count,
 * total bytes and time) through the same public fetcher; identical bytes are
 * stored once. Every saved image gets a pinned reference listing all source
 * URLs and alt text that led to it, and whether it is the thumbnail. A
 * failure leaves that image out: the set may be partial, never dangling,
 * and the capture is never blocked.
 */
export async function retainEmbeddedImages(
  record: CollectionRecord,
  deps: {
    fetcher: ImageFetcherPort;
    artifacts: Pick<GitArtifactStore, "writeBinary">;
    signal: AbortSignal;
    deadlineMs?: number;
  },
): Promise<{ record: CollectionRecord; report: EmbeddedRetentionReport }> {
  const html = record.supplied.articleHtml;
  const report: EmbeddedRetentionReport = { retained: 0, failed: 0, truncated: false };
  if (!html || record.images) return { record, report };
  // Group candidates by URL, keeping every alt text in document order.
  const byUrl = new Map<string, string[]>();
  for (const c of embeddedImageCandidates(html)) {
    const alts = byUrl.get(c.url) ?? [];
    if (c.alt && !alts.includes(c.alt)) alts.push(c.alt);
    byUrl.set(c.url, alts);
  }
  const thumbnail = record.previewImage;
  type Item = NonNullable<CollectionRecord["images"]>["items"][number];
  const items: Item[] = [];
  const byHash = new Map<string, Item>();
  // The thumbnail is retained first (retainPreviewImage); reuse it here.
  if (thumbnail?.retained) {
    const item: Item = {
      artifact: thumbnail.retained.artifact,
      contentType: thumbnail.retained.contentType,
      bytes: thumbnail.retained.bytes,
      thumbnail: true,
      sources: [{ url: thumbnail.url }],
    };
    items.push(item);
    byHash.set(thumbnail.retained.artifact.hash, item);
  }
  const deadline = AbortSignal.timeout(deps.deadlineMs ?? EMBEDDED_DEADLINE_MS);
  const signal = AbortSignal.any([deps.signal, deadline]);
  let total = 0;
  let fetched = 0;
  for (const [url, alts] of byUrl) {
    const source = { url, ...(alts.length ? { alt: alts.join(" | ").slice(0, 1000) } : {}) };
    // The thumbnail URL is already retained: record the in-article source on it.
    const thumbItem = items.find((i) => i.thumbnail && i.sources.some((s) => s.url === url));
    if (thumbItem) {
      thumbItem.sources = thumbItem.sources.map((s) => (s.url === url ? source : s));
      continue;
    }
    if (fetched >= MAX_EMBEDDED_IMAGES || signal.aborted) {
      report.truncated = true;
      break;
    }
    fetched++;
    try {
      const { bytes, contentType } = await deps.fetcher.fetch(url, signal);
      if (total + bytes.length > MAX_EMBEDDED_BYTES) {
        report.truncated = true;
        break;
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      const existing = byHash.get(`sha256:${digest}`);
      if (existing) {
        existing.sources.push(source);
        continue;
      }
      const path = `substack/${record.item.publicationId}/${record.item.postId}/images/${digest}.${IMAGE_EXTENSIONS[contentType]}`;
      const ref = await deps.artifacts.writeBinary(path, bytes, digest);
      total += bytes.length;
      const item: Item = {
        artifact: {
          repository: ref.repository,
          commit: ref.commit,
          path: ref.path,
          hash: `sha256:${ref.sha256}`,
        },
        contentType,
        bytes: bytes.length,
        thumbnail: false,
        sources: [source],
      };
      items.push(item);
      byHash.set(item.artifact.hash, item);
      report.retained++;
    } catch {
      report.failed++;
    }
  }
  if (items.length === 0) return { record, report };
  return {
    record: {
      ...record,
      images: {
        version: "retained-images-v1",
        items,
        ...(report.truncated ? { truncated: true } : {}),
        ...(report.failed ? { failed: report.failed } : {}),
      },
    },
    report,
  };
}
