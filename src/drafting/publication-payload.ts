import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import { PublicationFieldsSchema, type PublicationFields } from "../content/publication-fields.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { writeOnce } from "../research/job.js";
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

const Base = z.object({
  schemaVersion: z.literal(1),
  metadata: ArtifactReferenceSchema,
  body: ArtifactReferenceSchema,
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
/** An immutable manifest, never a second body or a regenerated title. */
export const PublicationPayloadSchema = z
  .discriminatedUnion("mode", [
    Base.extend({ mode: z.literal("structured"), fields: PublicationFieldsSchema }).strict(),
    Base.extend({ mode: z.literal("legacy-body-only") }).strict(),
  ])
  .refine((payload) => payload.contentHash === publicationContentHash(payload), {
    message: "publication content hash mismatch",
  });
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
  a.repository === b.repository && a.commit === b.commit && a.path === b.path && a.hash === b.hash;

/** Save the exact metadata/body association before verification. */
export async function savePublicationPayload(input: {
  content: GitArtifactStore;
  metadata: ArtifactRef;
  body: ArtifactRef;
  post: { publicationId: string; postId: string };
}): Promise<{ ref: ArtifactRef; payload: PublicationPayload }> {
  const metadata = PackageDraftMetadataSchema.parse(
    JSON.parse(await input.content.read(input.metadata)),
  );
  if (metadata.draft !== `${input.body.commit}:${input.body.path}`)
    throw new PublicationPayloadError();
  const candidate = {
    schemaVersion: 1,
    metadata: artifactReference(input.metadata),
    body: artifactReference(input.body),
    ...(metadata.fields
      ? { mode: "structured" as const, fields: metadata.fields }
      : { mode: "legacy-body-only" as const }),
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
  const payload = PublicationPayloadSchema.parse(JSON.parse(await content.read(artifactRef(ref))));
  if (publicationManifestHash(payload) !== ref.hash) throw new PublicationPayloadError();
  const metadata = PackageDraftMetadataSchema.parse(
    JSON.parse(await content.read(artifactRef(payload.metadata))),
  );
  if (
    metadata.draft !== `${payload.body.commit}:${payload.body.path}` ||
    (payload.mode === "structured"
      ? JSON.stringify(metadata.fields) !== JSON.stringify(payload.fields)
      : metadata.fields !== undefined)
  )
    throw new PublicationPayloadError();
  const markdown = await content.read(artifactRef(payload.body));
  return { payload, markdown };
}
