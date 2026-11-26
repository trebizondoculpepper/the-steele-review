import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The contract's canonical source bundle (`source-bundle-v1`,
 * doc/experiments/n8n-vs-mastra.md "Canonical source bundle"). The source
 * version ID is the SHA-256 of these canonical bytes, so both platforms
 * derive the same ID for the same content.
 */

export const SourceBundleSchema = z
  .object({
    schema: z.literal("source-bundle-v1"),
    item: z.string().regex(/^substack:[a-z0-9-]+:\d{1,15}$/),
    postId: z.string().regex(/^\d{1,15}$/),
    slug: z.string().regex(/^[a-z0-9-]{1,200}$/),
    url: z.string().regex(/^https:\/\/[a-z0-9.-]+\/p\/[a-z0-9-]{1,200}$/),
    title: z.string().max(1000),
    publishedAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    author: z.string().nullable(),
    medium: z.enum(["audio", "video", "written", "unknown"]),
    audience: z.string(),
    mediaUploadId: z.string().nullable(),
    textSource: z.enum(["supplied-transcript", "article-html"]),
    text: z.string().max(2_000_000),
  })
  .strict();
export type SourceBundle = z.infer<typeof SourceBundleSchema>;

/**
 * RFC 8785 JSON Canonicalization for the value shapes a bundle can hold
 * (objects, strings and null): keys sorted by UTF-16 code units, no
 * insignificant whitespace, and JSON.stringify's string escaping, which
 * matches RFC 8785 for strings.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new Error(`canonicalize: unsupported ${typeof value}`);
}

/** The contract's text normalisation: NFC, LF line endings, no trailing whitespace. */
export function normaliseText(text: string): string {
  return text.replace(/\r\n/g, "\n").normalize("NFC").trimEnd();
}

export function bundleBytes(bundle: SourceBundle): string {
  return canonicalize(SourceBundleSchema.parse(bundle));
}

export function bundleHash(bundle: SourceBundle): string {
  return createHash("sha256").update(bundleBytes(bundle), "utf8").digest("hex");
}

export function sourceVersionId(bundle: SourceBundle): string {
  return `${bundle.item}@sha256:${bundleHash(bundle)}`;
}
