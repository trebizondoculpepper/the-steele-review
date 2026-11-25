import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ArtifactReferenceSchema,
  type ArtifactReference,
} from "../content/artifact-reference.js";
import {
  PublicationFieldsSchema,
  type PublicationFields,
} from "../content/publication-fields.js";
import type {
  ArtifactRef,
  GitArtifactStore,
} from "../controllers/artifact-store.js";
import { writeOnce } from "../research/job.js";
import { classifyArticlePath } from "./article-identity.js";
import { PackageDraftMetadataSchema } from "./package-draft.js";

export class PublicationPayloadError extends Error {
  constructor() {
    super("publication payload mismatch");
    this.name = "PublicationPayloadError";
  }
}

type PayloadContent = { body: { hash: string } } & (
  | { mode: "structured"; fields: PublicationFields }
  | { mode: "legacy-body-only" }
);
/** Reader-visible identity excludes provenance; identical content must not publish twice. */
export function publicationContentHash(payload: PayloadContent): string {
  if (payload.mode === "legacy-body-only") return payload.body.hash;
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        payload.fields.title,
        payload.fields.subtitle,
        payload.fields.excerpt,
        payload.body.hash,
      ]),
    )
    .digest("hex")}`;
}

/**
 * The source's retained preview image (#893), for a destination's featured
 * image: the exact content-addressed artifact saved with the source capture.
 */
export const PublicationPreviewImageSchema = z
  .object({
    artifact: ArtifactReferenceSchema,
    contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    bytes: z.number().int().positive(),
  })
  .strict();
export type PublicationPreviewImage = z.infer<
  typeof PublicationPreviewImageSchema
>;

const Base = z.object({
  schemaVersion: z.literal(1),
  metadata: ArtifactReferenceSchema,
  body: ArtifactReferenceSchema,
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** Absent when the source has no retained preview, and on earlier manifests. */
  previewImage: PublicationPreviewImageSchema.optional(),
});
/** An immutable manifest, never a second body or a regenerated title. */
export const PublicationPayloadSchema = z
  .discriminatedUnion("mode", [
    Base.extend({
      mode: z.literal("structured"),
      fields: PublicationFieldsSchema,
    }).strict(),
    Base.extend({ mode: z.literal("legacy-body-only") }).strict(),
  ])
  .refine(
    (payload) => payload.contentHash === publicationContentHash(payload),
    {
      message: "publication content hash mismatch",
    },
  );
export type PublicationPayload = z.infer<typeof PublicationPayloadSchema>;
/** Canonical manifest bytes are part of the exact verification identity. */
export const publicationManifestHash = (payload: PublicationPayload) =>
  `sha256:${createHash("sha256")
    .update(`${JSON.stringify(payload, null, 2)}\n`)
    .digest("hex")}`;
export const artifactReference = (ref: ArtifactRef): ArtifactReference => ({
  repository: ref.repository,
  commit: ref.commit,
  path: ref.path,
  hash: `sha256:${ref.sha256}`,
});
export const artifactRef = (ref: ArtifactReference): ArtifactRef => ({
  repository: ref.repository,
  commit: ref.commit,
  path: ref.path,
  sha256: ref.hash.slice(7),
});
export const sameArtifact = (a: ArtifactReference, b: ArtifactReference) =>
  a.repository === b.repository &&
  a.commit === b.commit &&
  a.path === b.path &&
  a.hash === b.hash;

/**
 * Canonical metadata retains the write-once generation pointer (a Git commit
 * cannot embed its own hash). A canonical snapshot is an exact alias only
 * when both files share a pinned commit and its body matches that generation.
 */
export async function assertMetadataBodyBinding(
  content: Pick<GitArtifactStore, "read">,
  metadataRef: ArtifactRef,
  metadata: z.infer<typeof PackageDraftMetadataSchema>,
  body: ArtifactRef,
): Promise<void> {
  if (metadata.draft === `${body.commit}:${body.path}`) return;
  const canonical = classifyArticlePath(body.path);
  const metaPath = classifyArticlePath(metadataRef.path);
  const separator = metadata.draft.indexOf(":");
  const generationCommit = metadata.draft.slice(0, separator);
  const generationPath = metadata.draft.slice(separator + 1);
  const generation = classifyArticlePath(generationPath);
  if (
    canonical?.kind !== "canonical" ||
    canonical.part !== "body" ||
    metaPath?.kind !== "canonical" ||
    metaPath.part !== "metadata" ||
    canonical.id !== metaPath.id ||
    canonical.publicationId !== metaPath.publicationId ||
    canonical.postId !== metaPath.postId ||
    metadataRef.commit !== body.commit ||
    metadataRef.repository !== body.repository ||
    generation?.kind !== "legacy-generation" ||
    generation.part !== "body" ||
    generation.publicationId !== canonical.publicationId ||
    generation.postId !== canonical.postId ||
    !/^[0-9a-f]{40}$/.test(generationCommit)
  )
    throw new PublicationPayloadError();
  // GitArtifactStore verifies the supplied hash as well as commit/path. Using
  // the canonical hash proves equality without resolving any current head.
  await content.read({
    ...body,
    commit: generationCommit,
    path: generationPath,
  });
}

/** Save the exact metadata/body association before verification. */
export async function savePublicationPayload(input: {
  content: GitArtifactStore;
  metadata: ArtifactRef;
  body: ArtifactRef;
  post: { publicationId: string; postId: string };
  /** The source's retained preview image, when it has one. */
  previewImage?: PublicationPreviewImage;
}): Promise<{ ref: ArtifactRef; payload: PublicationPayload }> {
  const metadata = PackageDraftMetadataSchema.parse(
    JSON.parse(await input.content.read(input.metadata)),
  );
  await assertMetadataBodyBinding(
    input.content,
    input.metadata,
    metadata,
    input.body,
  );
  const candidate = {
    schemaVersion: 1,
    metadata: artifactReference(input.metadata),
    body: artifactReference(input.body),
    ...(metadata.fields
      ? { mode: "structured" as const, fields: metadata.fields }
      : { mode: "legacy-body-only" as const }),
    ...(input.previewImage
      ? {
          previewImage: PublicationPreviewImageSchema.parse(input.previewImage),
        }
      : {}),
  };
  const payload = PublicationPayloadSchema.parse({
    ...candidate,
    contentHash: publicationContentHash(candidate),
  });
  const key = publicationManifestHash(payload).slice(7);
  const ref = await writeOnce(
    input.content,
    `publication-payloads/${input.post.publicationId}/${input.post.postId}/${key}.json`,
    payload,
  );
  return { ref, payload };
}

/** Re-read pinned fields and bytes; never attach current metadata to old approval. */
export async function readPublicationPayload(
  content: Pick<GitArtifactStore, "read">,
  ref: ArtifactReference,
): Promise<{ payload: PublicationPayload; markdown: string }> {
  const payload = PublicationPayloadSchema.parse(
    JSON.parse(await content.read(artifactRef(ref))),
  );
  if (publicationManifestHash(payload) !== ref.hash)
    throw new PublicationPayloadError();
  const metadata = PackageDraftMetadataSchema.parse(
    JSON.parse(await content.read(artifactRef(payload.metadata))),
  );
  await assertMetadataBodyBinding(
    content,
    artifactRef(payload.metadata),
    metadata,
    artifactRef(payload.body),
  );
  if (
    payload.mode === "structured"
      ? JSON.stringify(metadata.fields) !== JSON.stringify(payload.fields)
      : metadata.fields !== undefined
  )
    throw new PublicationPayloadError();
  const markdown = await content.read(artifactRef(payload.body));
  return { payload, markdown };
}
