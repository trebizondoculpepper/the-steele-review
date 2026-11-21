import { CollectionRecordSchema } from "../collection/collection-store.js";
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
    source: z
      .object({
        artifact: Ref,
        sourceVersion: z.string(),
        /**
         * Public link to the original post, from the archived capture (#276).
         * Absent only in packages built before #276 or without the archive.
         */
        originalUrl: z.url({ protocol: /^https$/ }).optional(),
        title: z.string().max(500).optional(),
      })
      .strict(),
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
    /**
     * Narrative and wider-movement context (#176). Optional so earlier packages
     * stay valid. Quoted evidence, generated comparison and gaps are distinct.
     */
    context: z
      .object({
        history: z
          .object({
            status: z.enum(["available", "gap"]),
            reason: z.string().optional(),
            /** Unattended runs (#370): a gap is left out of the article, not stated. */
            omitWhenAbsent: z.boolean().optional(),
            comparisons: z.array(
              z
                .object({
                  /** The saved comparison result this entry comes from, pinned. */
                  result: Ref,
                  claimId: z.string(),
                  kind: z.string(),
                  /** Same-speaker pattern (#369): "recurring" needs two or more dated posts. */
                  pattern: z.enum(["recurring", "single-comparison", "none"]).optional(),
                  uncertainty: z.enum(["low", "medium", "high"]),
                  /** Quoted evidence: the current post's passage. */
                  current: z.object({ quote: z.string(), artifact: Ref }).strict(),
                  /** Quoted evidence: exact earlier passages with dates, links and archive refs. */
                  earlier: z.array(
                    z
                      .object({
                        postId: z.string(),
                        publishedAt: z.string(),
                        url: z.string().optional(),
                        quote: z.string(),
                        artifact: Ref,
                        start: z.number().int(),
                        end: z.number().int(),
                      })
                      .strict(),
                  ),
                  /** Generated comparison text; never evidence. */
                  comparison: z.object({ text: z.string(), isEvidence: z.literal(false) }).strict(),
                  conflictRationale: z.string().optional(),
                  changedCircumstances: z.string().optional(),
                })
                .strict(),
            ),
          })
          .strict(),
        background: z
          .object({
            status: z.enum(["available", "gap"]),
            reason: z.string().optional(),
            /** Independently sourced passages from the mapped dossiers' pinned versions. */
            passages: z.array(
              z
                .object({
                  dossierId: z.string(),
                  dossier: Ref,
                  url: z.string(),
                  title: z.string(),
                  passage: z.string(),
                  checkedAt: z.string(),
                  sourceDate: z.string().optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      })
      .strict()
      .optional(),
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
/** Bounds on context carried into a package (#176). */
export const MAX_COMPARISONS = 20;
export const MAX_BACKGROUND_PASSAGES = 30;

const ComparisonResultSchema = z.looseObject({
  claimId: z.string(),
  pattern: z.enum(["recurring", "single-comparison", "none"]).optional(),
  findings: z.array(
    z.looseObject({
      kind: z.string(),
      explanation: z.looseObject({ text: z.string(), isEvidence: z.literal(false) }),
      uncertainty: z.enum(["low", "medium", "high"]),
      changedCircumstances: z.string().optional(),
      conflictRationale: z.string().optional(),
      current: z.looseObject({ quote: z.string(), artifact: Ref, sourceVersion: z.string() }),
      earlier: z.array(
        z.looseObject({
          postId: z.string(),
          publishedAt: z.string(),
          url: z.string().optional(),
          quote: z.string(),
          artifact: Ref,
          start: z.number().int(),
          end: z.number().int(),
        }),
      ),
    }),
  ),
});

export async function buildWriterPackage(input: {
  content: GitArtifactStore;
  /** Archive holding the source post; when given, the pinned source is verified too. */
  archive?: GitArtifactStore;
  coverage: ArtifactRef;
  /** Saved historical comparison results for this post (#36), by exact reference. */
  comparisons?: ArtifactRef[];
  /** "omit" (unattended runs, #370): missing history is not discussed in the article. */
  historyGap?: "state" | "omit";
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
  // The original post's link and title come from the pinned capture itself.
  let original: { originalUrl?: string; title?: string } = {};
  if (input.archive) {
    const captured = CollectionRecordSchema.safeParse(
      JSON.parse(await readPinned(input.archive, record.source, "source post")),
    );
    if (captured.success) {
      original = {
        originalUrl: captured.data.item.url,
        ...(captured.data.item.title ? { title: captured.data.item.title.slice(0, 500) } : {}),
      };
    }
  }

  // Archived snapshots per (job, cited URL), from each job's pinned manifest:
  // a claim's evidence is resolved from the jobs that supported it, never from
  // another job that happened to fetch the same URL.
  const archivedByJobUrl = new Map<string, z.infer<typeof Ref>>();
  for (const job of record.jobs) {
    if (!job.manifest) continue;
    const manifest = ResearchManifestSchema.parse(
      JSON.parse(await readPinned(input.content, job.manifest, `manifest for ${job.jobId}`)),
    );
    for (const c of manifest.citations) {
      if (c.archivedArtifact)
        archivedByJobUrl.set(JSON.stringify([job.jobId, c.url]), c.archivedArtifact);
    }
  }
  // Every dossier version the package relies on must still be readable as pinned.
  const background: NonNullable<WriterPackage["context"]>["background"]["passages"] = [];
  for (const d of record.dossiers) {
    const dossier = parseDossier(await readPinned(input.content, d.ref, `dossier ${d.dossierId}`));
    for (const c of dossier.metadata.citations) {
      if (background.length >= MAX_BACKGROUND_PASSAGES) break;
      background.push({
        dossierId: d.dossierId,
        dossier: d.ref,
        url: c.url,
        title: c.title,
        passage: c.passage,
        checkedAt: c.checkedAt,
        ...(c.sourceDate ? { sourceDate: c.sourceDate } : {}),
      });
    }
  }

  // Historical comparisons: only findings about this exact source version.
  const history: NonNullable<WriterPackage["context"]>["history"]["comparisons"] = [];
  for (const ref of input.comparisons ?? []) {
    const result = ComparisonResultSchema.parse(
      JSON.parse(await readPinned(input.content, toRefRecord(ref), "comparison result")),
    );
    for (const f of result.findings) {
      if (history.length >= MAX_COMPARISONS) break;
      // A finding without earlier passages (for example "insufficient-context")
      // is not historical evidence; it never makes history available.
      if (f.earlier.length === 0) {
        if (f.current.sourceVersion !== themes.sourceVersion) {
          throw new PackageInputError("comparison result describes another source version");
        }
        continue;
      }
      if (
        !sameRef(f.current.artifact, record.source) ||
        f.current.sourceVersion !== themes.sourceVersion
      ) {
        throw new PackageInputError("comparison result describes another source version");
      }
      history.push({
        result: toRefRecord(ref),
        claimId: result.claimId,
        kind: f.kind,
        ...(result.pattern ? { pattern: result.pattern } : {}),
        uncertainty: f.uncertainty,
        current: { quote: f.current.quote, artifact: f.current.artifact },
        earlier: f.earlier.map((e) => ({
          postId: e.postId,
          publishedAt: e.publishedAt,
          ...(e.url ? { url: e.url } : {}),
          quote: e.quote,
          artifact: e.artifact,
          start: e.start,
          end: e.end,
        })),
        comparison: { text: f.explanation.text, isEvidence: false },
        ...(f.conflictRationale ? { conflictRationale: f.conflictRationale } : {}),
        ...(f.changedCircumstances ? { changedCircumstances: f.changedCircumstances } : {}),
      });
    }
  }
  const context: WriterPackage["context"] = {
    history:
      history.length > 0
        ? { status: "available", comparisons: history }
        : {
            status: "gap",
            reason:
              (input.comparisons ?? []).length === 0
                ? "no historical comparison was supplied"
                : "the supplied comparisons found no earlier passages",
            ...(input.historyGap === "omit" ? { omitWhenAbsent: true } : {}),
            comparisons: [],
          },
    background:
      background.length > 0
        ? { status: "available", passages: background }
        : {
            status: "gap",
            reason: "the mapped dossiers hold no independently cited background",
            passages: [],
          },
  };

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
              ...(() => {
                // Latest supporting job first (a second pass supersedes the first).
                for (const jobId of [...c.jobIds].reverse()) {
                  const hit = archivedByJobUrl.get(JSON.stringify([jobId, e.url]));
                  if (hit) return { archived: hit };
                }
                return {};
              })(),
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
    source: { artifact: record.source, sourceVersion: themes.sourceVersion, ...original },
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
    context,
  });
}

const toRefRecord = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

/** Build, then save write-once at a content-addressed path. Reruns reuse the same artifact. */
export async function saveWriterPackage(input: {
  content: GitArtifactStore;
  archive?: GitArtifactStore;
  coverage: ArtifactRef;
  comparisons?: ArtifactRef[];
  historyGap?: "state" | "omit";
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
