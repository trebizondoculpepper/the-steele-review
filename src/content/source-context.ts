import { createHash } from "node:crypto";
import { z } from "zod";
import type { CollectionRecord } from "../collection/collection-store.js";
import { ArtifactReferenceSchema, type ArtifactReference } from "./artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { PostAuthorResolution } from "./source-metadata.js";
import { sourceVersionFor } from "./fulltext-document.js";
import { writeOnce } from "../research/job.js";

export const ObservedDateSchema = z.union([
  z.iso.datetime({ offset: true }).max(100),
  z.iso.date(),
]);
export const OriginalMediumSchema = z.enum([
  "written",
  "video",
  "audio",
  "image",
  "mixed",
  "unknown",
]);
export const TemporalContextSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("timestamp"),
      basis: z.enum(["source-observed", "archive-value", "capture-clock"]),
      original: z.iso.datetime({ offset: true }).max(100),
      utc: z.iso.datetime(),
      precision: z.enum(["minute", "second", "fractional-second"]),
      fractionDigits: z.number().int().min(1).max(100).optional(),
      offset: z.string().regex(/^(Z|[+-]\d{2}:\d{2})$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("date"),
      basis: z.enum(["source-observed", "archive-value", "capture-clock"]),
      original: z.iso.date(),
      precision: z.literal("day"),
    })
    .strict(),
  z
    .object({ kind: z.literal("unknown"), reason: z.enum(["not-supplied", "invalid-observation"]) })
    .strict(),
]);
export type TemporalContext = z.infer<typeof TemporalContextSchema>;
export function temporalContext(
  value: unknown,
  basis: "source-observed" | "archive-value" | "capture-clock" = "source-observed",
): TemporalContext {
  if (value === undefined || value === null || value === "")
    return { kind: "unknown", reason: "not-supplied" };
  const parsed = ObservedDateSchema.safeParse(value);
  if (!parsed.success) return { kind: "unknown", reason: "invalid-observation" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(parsed.data))
    return { kind: "date", basis, original: parsed.data, precision: "day" };
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(parsed.data)?.[1];
  return TemporalContextSchema.parse({
    kind: "timestamp",
    basis,
    original: parsed.data,
    utc: new Date(parsed.data).toISOString(),
    precision: fraction
      ? "fractional-second"
      : /T\d{2}:\d{2}:\d{2}/.test(parsed.data)
        ? "second"
        : "minute",
    ...(fraction ? { fractionDigits: fraction.length } : {}),
    offset: /(Z|[+-]\d{2}:\d{2})$/.exec(parsed.data)![1],
  });
}
const Author = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("resolved"),
      author: z.string().min(1).max(200),
      authorId: z.string().min(1).max(200).optional(),
      basis: z.enum(["post-byline", "source-configured"]),
      sourceMetadataVersion: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      reason: z.enum(["no-byline-no-default", "ambiguous-byline", "legacy-unconfigured"]),
      sourceMetadataVersion: z.string().min(1).max(300).optional(),
      observedByline: z.string().max(200).optional(),
    })
    .strict(),
]);
/** Normalise older resolved-only extraction attribution without guessing a person. */
export function recordedSourceAttribution(value: unknown): PostAuthorResolution | undefined {
  if (!value || typeof value !== "object") return;
  const tagged = "status" in value ? value : { ...value, status: "resolved" };
  const parsed = Author.safeParse(tagged);
  if (!parsed.success) return;
  if (parsed.data.status === "resolved") return parsed.data;
  if (parsed.data.reason !== "legacy-unconfigured" && parsed.data.sourceMetadataVersion)
    return {
      status: "unknown",
      reason: parsed.data.reason,
      sourceMetadataVersion: parsed.data.sourceMetadataVersion,
    };
}
export const SourceContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z
      .object({
        type: z.literal("substack"),
        id: z.string().min(1).max(200),
        postId: z.string().min(1).max(200),
        url: z.url({ protocol: /^https$/ }),
        title: z.string().max(500),
        archive: ArtifactReferenceSchema,
        sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .strict(),
    author: Author,
    originalMedium: OriginalMediumSchema,
    mediumBasis: z.enum([
      "observed-medium",
      "archived-post-type",
      "archived-media-kind",
      "legacy-unknown",
    ]),
    representation: z.enum(["article-text", "transcript", "article-and-transcript", "unknown"]),
    publishedAt: TemporalContextSchema,
    sourceUpdatedAt: TemporalContextSchema,
    capturedAt: TemporalContextSchema,
    originalMedia: z
      .array(
        z
          .object({
            kind: z.enum(["source-page", "upload-id"]),
            reference: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(5),
    transcript: z
      .object({
        archive: ArtifactReferenceSchema,
        location: z.enum(["supplied.transcript", "supplied.transcriptDocument", "text"]),
        machineGenerated: z.boolean().optional(),
        inputMedium: z.enum(["audio", "video"]).optional(),
        uploadId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,200}$/)
          .optional(),
        language: z.string().min(1).max(40).optional(),
        segments: z
          .array(
            z
              .object({
                index: z.number().int().nonnegative(),
                start: z.number().nonnegative().optional(),
                end: z.number().nonnegative().optional(),
              })
              .strict(),
          )
          .max(10000),
      })
      .strict()
      .optional(),
    inspected: z
      .object({
        suppliedText: z.literal(true),
        video: z.literal(false),
        audio: z.literal(false),
        images: z.literal(false),
      })
      .strict(),
  })
  .strict();
export type SourceContext = z.infer<typeof SourceContextSchema>;
export const contextArtifactReference = (r: ArtifactRef): ArtifactReference => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
export function sourceContextVersion(context: SourceContext): string {
  return `source-context-sha256:${createHash("sha256")
    .update(JSON.stringify(SourceContextSchema.parse(context)))
    .digest("hex")}`;
}

/** Interpret observed archive metadata, never conversational style or visual claims. */
export function sourceContextFor(
  record: CollectionRecord,
  archive: ArtifactRef,
  attribution?: PostAuthorResolution,
): SourceContext {
  const p = record.provenance;
  const hasTranscript = Boolean(
    record.supplied.transcript || record.supplied.transcriptDocument || /transcript/.test(p.method),
  );
  const hasArticle = Boolean(record.supplied.articleHtml);
  let medium: SourceContext["originalMedium"] = "unknown";
  let basis: SourceContext["mediumBasis"] = "legacy-unknown";
  const observed = OriginalMediumSchema.safeParse(p.originalMedium);
  if (observed.success) {
    medium = observed.data;
    basis = "observed-medium";
  } else if (p.postType === "video") {
    medium = "video";
    basis = "archived-post-type";
  } else if (p.postType === "image") {
    medium = "image";
    basis = "archived-post-type";
  } else if (p.postType === "audio") {
    medium = "audio";
    basis = "archived-post-type";
  } else if ((p.postType === "newsletter" || p.postType === "text") && !hasTranscript) {
    medium = "written";
    basis = "archived-post-type";
  } else if (p.mediaKind === "video") {
    medium = p.mediaKind;
    basis = "archived-media-kind";
  }
  const author = attribution
    ? Author.parse(attribution)
    : {
        status: "unknown" as const,
        reason: "legacy-unconfigured" as const,
        ...(record.item.author ? { observedByline: record.item.author } : {}),
      };
  const archiveRef = contextArtifactReference(archive);
  const language = z.string().min(1).max(40).safeParse(p.transcriptLanguage);
  const originalUpload = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .safeParse(p.originalMediaUploadId);
  const transcriptUpload = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .safeParse(p.mediaUploadId);
  const inputMedium = z.enum(["audio", "video"]).safeParse(p.mediaUploadKind ?? p.mediaKind);
  return SourceContextSchema.parse({
    schemaVersion: 1,
    source: {
      type: "substack",
      id: record.item.publicationId,
      postId: record.item.postId,
      url: record.item.url,
      title: record.item.title,
      archive: archiveRef,
      sourceVersion: sourceVersionFor(record.text),
    },
    author,
    originalMedium: medium,
    mediumBasis: basis,
    representation: hasTranscript
      ? hasArticle
        ? "article-and-transcript"
        : "transcript"
      : hasArticle || p.method === "article-html"
        ? "article-text"
        : "unknown",
    publishedAt: temporalContext(
      p.observedPublishedAt ?? record.item.publishedAt,
      p.observedPublishedAt !== undefined ? "source-observed" : "archive-value",
    ),
    sourceUpdatedAt: temporalContext(
      p.observedUpdatedAt ?? record.item.updatedAt,
      p.observedUpdatedAt !== undefined ? "source-observed" : "archive-value",
    ),
    capturedAt: temporalContext(p.acquiredAt, "capture-clock"),
    originalMedia: [
      { kind: "source-page", reference: record.item.url },
      ...(originalUpload.success ? [{ kind: "upload-id", reference: originalUpload.data }] : []),
    ],
    ...(hasTranscript
      ? {
          transcript: {
            archive: archiveRef,
            location: record.supplied.transcript
              ? "supplied.transcript"
              : record.supplied.transcriptDocument
                ? "supplied.transcriptDocument"
                : "text",
            ...(inputMedium.success ? { inputMedium: inputMedium.data } : {}),
            ...(transcriptUpload.success ? { uploadId: transcriptUpload.data } : {}),
            ...(typeof p.machineGenerated === "boolean"
              ? { machineGenerated: p.machineGenerated }
              : {}),
            ...(language.success ? { language: language.data } : {}),
            segments: (record.supplied.transcript ?? []).map((s, index) => ({
              index,
              ...(s.start !== undefined ? { start: s.start } : {}),
              ...(s.end !== undefined ? { end: s.end } : {}),
            })),
          },
        }
      : {}),
    inspected: { suppliedText: true, video: false, audio: false, images: false },
  });
}
export async function saveSourceContext(
  content: GitArtifactStore,
  context: SourceContext,
): Promise<ArtifactRef> {
  const value = SourceContextSchema.parse(context);
  return writeOnce(
    content,
    `source-contexts/${sourceContextVersion(value).split(":")[1]}.json`,
    value,
  );
}
export function sourceContextMatches(
  context: SourceContext,
  archive: ArtifactRef,
  sourceVersion: string,
): boolean {
  const r = context.source.archive;
  return (
    context.source.sourceVersion === sourceVersion &&
    r.repository === archive.repository &&
    r.commit === archive.commit &&
    r.path === archive.path &&
    r.hash === `sha256:${archive.sha256}`
  );
}

export class SourceContextError extends Error {
  constructor(readonly code: "unavailable" | "mismatch") {
    super(`source context ${code}`);
    this.name = "SourceContextError";
  }
}
export async function readSourceContext(
  content: Pick<GitArtifactStore, "read">,
  reference: ArtifactRef,
  archive: ArtifactRef,
  sourceVersion: string,
  post: { publicationId: string; postId: string; url?: string },
): Promise<SourceContext> {
  let context: SourceContext;
  try {
    context = SourceContextSchema.parse(JSON.parse(await content.read(reference)));
  } catch {
    throw new SourceContextError("unavailable");
  }
  if (
    !sourceContextMatches(context, archive, sourceVersion) ||
    context.source.id !== post.publicationId ||
    context.source.postId !== post.postId ||
    (post.url !== undefined && context.source.url !== post.url)
  )
    throw new SourceContextError("mismatch");
  return context;
}
