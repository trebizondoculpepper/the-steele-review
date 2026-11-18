import { z } from "zod";

/**
 * Reference to one immutable artifact in a Git-backed archive.
 *
 * Provenance is expressed by logical repository name, the full commit SHA, the
 * path relative to that repository and the content hash. Never use a URL, host
 * or absolute filesystem path: archives are addressed by identity, and a host
 * detail would leak private infrastructure into public records.
 */

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_PATH = 1024;

function isRelativeArtifactPath(path: string): boolean {
  if (path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  // Reject Windows drive prefixes and any parent traversal segment.
  if (/^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").includes("..");
}

export const ArtifactReferenceSchema = z
  .object({
    repository: z
      .string()
      .regex(REPOSITORY)
      .describe("Logical repository name of the archive that holds the artifact."),
    commit: z
      .string()
      .regex(COMMIT)
      .describe("Full 40-character Git commit SHA that contains the artifact."),
    path: z
      .string()
      .min(1)
      .max(MAX_PATH)
      .refine(isRelativeArtifactPath, {
        message: "path must be relative, use forward slashes and contain no '..' segment",
      })
      .describe("Artifact path relative to the repository root."),
    hash: z
      .string()
      .regex(HASH)
      .describe("Content hash of the artifact bytes, as `sha256:<64 lower-case hex>`."),
  })
  .strict()
  .meta({
    title: "ArtifactReference",
    description:
      "Immutable reference to an archived artifact: logical repository, commit, relative path and content hash.",
  });

export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

/** Validate an untrusted artifact reference, throwing a ZodError when malformed. */
export function parseArtifactReference(input: unknown): ArtifactReference {
  return ArtifactReferenceSchema.parse(input);
}

/** JSON Schema (draft 2020-12) for {@link ArtifactReferenceSchema}. */
export function artifactReferenceJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ArtifactReferenceSchema) as Record<string, unknown>;
}
