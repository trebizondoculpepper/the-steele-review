import { createHash } from "node:crypto";
import { z } from "zod";
import { parseThemeProposalResult } from "../analysis/theme-proposals.js";
import { ClaimExtractionRecordSchema } from "../analysis/grounded-claims.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { parseDossier } from "../research/dossier.js";
import { ResearchManifestSchema, writeOnce } from "../research/job.js";
import { CoverageRecordSchema, type CoverageRecord } from "../research/librarian.js";

/**
 * Writer evidence package (#148): the librarian's saved coverage record,
 * validated and pinned into the exact inputs the writer (#149) receives.
 *
 * Every reference is read back by its exact, hash-verified version: the
 * source post, the theme and claim results, each research job's manifest and
 * each dossier version. The package records the original source reference
 * and version, the post's proposed themes, every accepted claim with its
 * coverage outcome, and for covered claims the cited passages with their
 * archived source snapshots. Gaps stay explicit and are never reclassified.
 *
 * Content-addressed and write-once: the same coverage record always yields
 * the same package, and a newer dossier or coverage version yields a new,
 * separate package while old packages stay readable.
 */

export const WRITER_PACKAGE_SCHEMA_VERSION = 1;

const Ref = z
  .object({ repository: z.string(), commit: z.string(), path: z.string(), hash: z.string() })
  .strict();

export const WriterPackageSchema = z
  .object({
    schemaVersion: z.literal(WRITER_PACKAGE_SCHEMA_VERSION),
    status: z.enum(["ready", "evidence-gap"]),
    post: z.object({ publicationId: z.string(), postId: z.string() }).strict(),
    /** Exact source post and version; the writer reads the full text from here. */
    source: z.object({ artifact: Ref, sourceVersion: z.string() }).strict(),
    coverage: Ref,
    themeResult: Ref,
    claimResult: Ref,
    themes: z.array(
      z.object({ id: z.string(), title: z.string(), description: z.string().optional() }).strict(),
    ),
    claims: z.array(
      z
        .object({
          claimRecordId: z.string(),
          statement: z.string(),
          dossierId: z.string().nullable(),
          status: z.enum(["covered", "gap"]),
          /** The librarian's coverage outcome, unchanged. */
          coverage: z.string(),
          reason: z.string().optional(),
          evidence: z.array(
            z
              .object({
                url: z.string(),
                passage: z.string(),
                /** Archived snapshot of the cited source, when the research job kept one. */
                archived: Ref.optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    dossiers: z.array(z.object({ dossierId: z.string(), ref: Ref }).strict()),
  })
  .strict();
export type WriterPackage = z.infer<typeof WriterPackageSchema>;

export class PackageInputError extends Error {
  constructor(reason: string) {
    super(`writer package input rejected: ${reason}`);
    this.name = "PackageInputError";
  }
}

const toArtifactRef = (r: z.infer<typeof Ref>): ArtifactRef => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.hash.replace(/^sha256:/, ""),
});

async function readPinned(
  store: GitArtifactStore,
  ref: z.infer<typeof Ref>,
  what: string,
): Promise<string> {
  try {
    return await store.read(toArtifactRef(ref));
  } catch {
    throw new PackageInputError(`${what} is missing or does not match its pinned version`);
  }
}

/** Build and validate the package from a saved coverage record (pure apart from pinned reads). */
export async function buildWriterPackage(input: {
  content: GitArtifactStore;
  /** Archive holding the source post; when given, the pinned source is verified too. */
  archive?: GitArtifactStore;
  coverage: ArtifactRef;
}): Promise<WriterPackage> {
  let record: CoverageRecord;
  try {
    record = CoverageRecordSchema.parse(JSON.parse(await input.content.read(input.coverage)));
  } catch {
    throw new PackageInputError("coverage record is missing, unreadable or invalid");
  }
  const themes = parseThemeProposalResult(
    JSON.parse(await readPinned(input.content, record.themeResult, "theme result")),
  );
  const claims = ClaimExtractionRecordSchema.parse(
    JSON.parse(await readPinned(input.content, record.claimResult, "claim result")),
  );
  const samePost = (p: { publicationId: string; postId: string }) =>
    p.publicationId === record.post.publicationId && p.postId === record.post.postId;
  if (!samePost(themes.post) || !samePost(claims.post)) {
    throw new PackageInputError("analysis results belong to another post");
  }
  if (themes.sourceVersion !== claims.sourceVersion) {
    throw new PackageInputError("theme and claim results describe different source versions");
  }
  const sameRef = (a: z.infer<typeof Ref>, b: z.infer<typeof Ref>) =>
    a.repository === b.repository &&
    a.commit === b.commit &&
    a.path === b.path &&
    a.hash === b.hash;
  if (!sameRef(themes.artifact, record.source)) {
    throw new PackageInputError("coverage record cites a different source version");
  }
  if (input.archive) await readPinned(input.archive, record.source, "source post");

  // Archived snapshots per cited URL, from each job's pinned manifest.
  const archivedByUrl = new Map<string, z.infer<typeof Ref>>();
  for (const job of record.jobs) {
    if (!job.manifest) continue;
    const manifest = ResearchManifestSchema.parse(
      JSON.parse(await readPinned(input.content, job.manifest, `manifest for ${job.jobId}`)),
    );
    for (const c of manifest.citations) {
      if (c.archivedArtifact && !archivedByUrl.has(c.url))
        archivedByUrl.set(c.url, c.archivedArtifact);
    }
  }
  // Every dossier version the package relies on must still be readable as pinned.
  for (const d of record.dossiers) {
    parseDossier(await readPinned(input.content, d.ref, `dossier ${d.dossierId}`));
  }

  const packageClaims: WriterPackage["claims"] = record.claims
    .filter((c) => c.status !== "pending")
    .map((c) => {
      const covered = c.status === "evidence-found" && c.citations.length > 0;
      return {
        claimRecordId: c.claimRecordId,
        statement: c.statement,
        dossierId: c.dossierId,
        status: covered ? ("covered" as const) : ("gap" as const),
        coverage: c.status,
        ...(c.reason ? { reason: c.reason } : {}),
        evidence: covered
          ? c.citations.map((e) => ({
              url: e.url,
              passage: e.passage,
              ...(archivedByUrl.has(e.url) ? { archived: archivedByUrl.get(e.url)! } : {}),
            }))
          : [],
      };
    });
  if (record.claims.some((c) => c.status === "pending")) {
    throw new PackageInputError(
      "research for some claims is still pending; package after it completes",
    );
  }
  return WriterPackageSchema.parse({
    schemaVersion: WRITER_PACKAGE_SCHEMA_VERSION,
    // With no independently supported claim there is nothing to cite: an explicit gap outcome.
    status: packageClaims.some((c) => c.status === "covered") ? "ready" : "evidence-gap",
    post: record.post,
    source: { artifact: record.source, sourceVersion: themes.sourceVersion },
    coverage: {
      repository: input.coverage.repository,
      commit: input.coverage.commit,
      path: input.coverage.path,
      hash: `sha256:${input.coverage.sha256}`,
    },
    themeResult: record.themeResult,
    claimResult: record.claimResult,
    themes: themes.proposals.map((p) => ({
      id: p.id,
      title: p.title,
      ...(p.description ? { description: p.description } : {}),
    })),
    claims: packageClaims,
    dossiers: record.dossiers,
  });
}

/** Build, then save write-once at a content-addressed path. Reruns reuse the same artifact. */
export async function saveWriterPackage(input: {
  content: GitArtifactStore;
  archive?: GitArtifactStore;
  coverage: ArtifactRef;
}): Promise<{ package: WriterPackage; ref: ArtifactRef }> {
  const pkg = await buildWriterPackage(input);
  const key = createHash("sha256").update(JSON.stringify(pkg)).digest("hex").slice(0, 32);
  const ref = await writeOnce(
    input.content,
    `writer-packages/${pkg.post.publicationId}/${pkg.post.postId}/${key}.json`,
    pkg,
  );
  return { package: WriterPackageSchema.parse(JSON.parse(await input.content.read(ref))), ref };
}
