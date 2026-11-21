import { createHash } from "node:crypto";
import { z } from "zod";
import { CollectionRecordSchema } from "../collection/collection-store.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import { transcriptTimingsFor } from "../content/embedding-consumer.js";
import { ArtifactRefSchema, type ArtifactRef } from "../controllers/artifact-store.js";
import { ClaimExtractionRecordSchema } from "./grounded-claims.js";
import { parseClaimOccurrence, type ClaimOccurrence } from "./claim-occurrence.js";
import { COVERAGE_CAVEAT } from "./claim-timeline.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,299}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const row = z
  .object({
    publicationId: id,
    postId: id,
    capture: ArtifactRefSchema,
    extraction: ArtifactRefSchema.optional(),
  })
  .strict();

/** Explicit, bounded sample: omitted posts are never presumed analysed. */
export const CorpusPeriodManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    family: z
      .object({
        name: z.string().trim().min(1).max(300),
        groupingKeys: z
          .array(z.string().regex(/^sha256:[0-9a-f]{64}$/))
          .min(1)
          .max(100),
      })
      .strict(),
    scope: z
      .object({
        description: z.string().trim().min(1).max(1000),
        publications: z.array(id).min(1).max(50),
        /** Whether this manifest exhausts the declared sample, not the internet. */
        complete: z.boolean(),
      })
      .strict(),
    /** UTC month boundaries, end exclusive, at most 120 months. */
    window: z.object({ start: month, end: month }).strict(),
    exactCopies: z.enum(["include", "exclude-identical-source"]).default("include"),
    posts: z.array(row).max(500),
  })
  .strict();
export type CorpusPeriodManifest = z.infer<typeof CorpusPeriodManifestSchema>;

export class CorpusPeriodError extends Error {
  constructor(readonly code: "invalid-manifest" | "ambiguous-revision" | "capture-mismatch") {
    super(`corpus periods: ${code}`);
  }
}

const counters = () => ({
  archivedPosts: 0,
  analysedPosts: 0,
  matchedPosts: 0,
  occurrences: 0,
  quotedOccurrences: 0,
  identicalSourceCopies: 0,
  excludedCopies: 0,
  missingExtractions: 0,
  invalidExtractions: 0,
  candidateClaims: 0,
  rejectedClaims: 0,
});
const count = z.number().int().nonnegative();
const PeriodSchema = z
  .object({
    month,
    archivedPosts: count,
    analysedPosts: count,
    matchedPosts: count,
    occurrences: count,
    quotedOccurrences: count,
    identicalSourceCopies: count,
    excludedCopies: count,
    missingExtractions: count,
    invalidExtractions: count,
    candidateClaims: count,
    rejectedClaims: count,
  })
  .strict()
  .refine(
    (p) =>
      p.matchedPosts <= p.analysedPosts &&
      p.matchedPosts <= p.occurrences &&
      p.quotedOccurrences <= p.occurrences &&
      p.identicalSourceCopies <= p.analysedPosts + p.excludedCopies &&
      p.analysedPosts + p.excludedCopies + p.missingExtractions + p.invalidExtractions ===
        p.archivedPosts,
    "inconsistent period counts",
  );
export const CorpusPeriodResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectorVersion: z.literal("corpus-periods-v1"),
    manifest: ArtifactRefSchema,
    family: CorpusPeriodManifestSchema.shape.family,
    scope: CorpusPeriodManifestSchema.shape.scope,
    window: CorpusPeriodManifestSchema.shape.window,
    exactCopies: CorpusPeriodManifestSchema.shape.exactCopies,
    periods: z.array(PeriodSchema).min(1).max(120),
    diagnostics: z
      .object({
        duplicateEntries: count,
        unavailableSources: count,
        invalidSources: count,
        unknownDates: count,
        outsideWindow: count,
        incompleteCaptures: count,
      })
      .strict(),
    truncated: z.boolean(),
    caveats: z.array(z.string()).max(20),
  })
  .strict();
export type CorpusPeriodResult = z.infer<typeof CorpusPeriodResultSchema>;

interface Reader {
  /** Artifact-controller read: verifies the logical repository and content hash. */
  read(ref: ArtifactRef): Promise<string>;
}
interface Store extends Reader {
  write(path: string, body: string): Promise<ArtifactRef>;
}
const ordinal = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5)) - 1;
const key = (p: { publicationId: string; postId: string }) => `${p.publicationId}/${p.postId}`;

/** No model calls, index creation or workflow mutations. All reads are pinned. */
export async function projectCorpusPeriods(input: {
  manifest: ArtifactRef;
  archive: Reader;
  content: Store;
}): Promise<{ ref: ArtifactRef; result: CorpusPeriodResult }> {
  let manifest: CorpusPeriodManifest;
  try {
    manifest = CorpusPeriodManifestSchema.parse(
      JSON.parse(await input.content.read(input.manifest)),
    );
  } catch {
    throw new CorpusPeriodError("invalid-manifest");
  }
  const start = ordinal(manifest.window.start),
    end = ordinal(manifest.window.end);
  if (end <= start || end - start > 120) throw new CorpusPeriodError("invalid-manifest");
  const periods = Array.from({ length: end - start }, (_, i) => ({
    month: `${Math.floor((start + i) / 12)
      .toString()
      .padStart(4, "0")}-${(((start + i) % 12) + 1).toString().padStart(2, "0")}`,
    ...counters(),
  }));
  const diagnostics = {
    duplicateEntries: 0,
    unavailableSources: 0,
    invalidSources: 0,
    unknownDates: 0,
    outsideWindow: 0,
    incompleteCaptures: 0,
  };
  const unique = new Map<string, z.infer<typeof row>>();
  for (const p of manifest.posts) {
    if (!manifest.scope.publications.includes(p.publicationId))
      throw new CorpusPeriodError("invalid-manifest");
    const previous = unique.get(key(p));
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(p))
        throw new CorpusPeriodError("ambiguous-revision");
      diagnostics.duplicateEntries++;
      continue;
    }
    unique.set(key(p), p);
  }
  const sources = [];
  for (const p of unique.values()) {
    let raw: string;
    try {
      raw = await input.archive.read(p.capture);
    } catch {
      diagnostics.unavailableSources++;
      continue;
    }
    let record;
    try {
      record = CollectionRecordSchema.parse(JSON.parse(raw));
    } catch {
      diagnostics.invalidSources++;
      continue;
    }
    if (key(record.item) !== key(p)) throw new CorpusPeriodError("capture-mismatch");
    if (!record.item.publishedAt) {
      diagnostics.unknownDates++;
      continue;
    }
    const time = new Date(record.item.publishedAt).toISOString();
    const period = ordinal(time.slice(0, 7)) - start;
    if (period < 0 || period >= periods.length) {
      diagnostics.outsideWindow++;
      continue;
    }
    sources.push({ p, record, time, period });
  }
  // Earliest observed complete analysis is the representative of identical
  // source text, with deterministic identity tie-breaking, within this window.
  sources.sort((a, b) => a.time.localeCompare(b.time) || key(a.p).localeCompare(key(b.p)));
  const seenSources = new Set<string>(),
    family = new Set(manifest.family.groupingKeys);
  for (const { p, record, period } of sources) {
    const bucket = periods[period];
    bucket.archivedPosts++;
    if (!record.complete) {
      diagnostics.incompleteCaptures++;
      bucket.missingExtractions++;
      continue;
    }
    if (!p.extraction) {
      bucket.missingExtractions++;
      continue;
    }
    const version = sourceVersionFor(record.text);
    const source = {
      text: record.text,
      sourceVersion: version,
      artifact: {
        repository: p.capture.repository,
        commit: p.capture.commit,
        path: p.capture.path,
        hash: `sha256:${p.capture.sha256}`,
      },
      publicationId: p.publicationId,
      postId: p.postId,
      url: record.item.url,
      publishedAt: record.item.publishedAt,
      author: record.item.author,
      ...transcriptTimingsFor(record),
    };
    let extraction, occurrences: Array<{ occurrence: ClaimOccurrence; kind: string }>;
    try {
      extraction = ClaimExtractionRecordSchema.parse(
        JSON.parse(await input.content.read(p.extraction)),
      );
      if (key(extraction.post) !== key(p) || extraction.sourceVersion !== version)
        throw new Error("identity");
      occurrences = extraction.claims.map((c) => ({
        occurrence: parseClaimOccurrence(c.occurrence, source),
        kind: c.kind,
      }));
    } catch {
      bucket.invalidExtractions++;
      continue;
    }
    bucket.candidateClaims += extraction.candidates?.length ?? 0;
    bucket.rejectedClaims += extraction.rejected.length;
    const copyKey = `${p.publicationId}:${version}`;
    if (seenSources.has(copyKey)) {
      bucket.identicalSourceCopies++;
      if (manifest.exactCopies === "exclude-identical-source") {
        bucket.excludedCopies++;
        continue;
      }
    }
    seenSources.add(copyKey);
    bucket.analysedPosts++;
    const seenOccurrences = new Set<string>();
    let matched = false;
    for (const { occurrence: o, kind } of occurrences) {
      if (!family.has(o.grouping.key) || seenOccurrences.has(o.occurrenceId)) continue;
      seenOccurrences.add(o.occurrenceId);
      matched = true;
      bucket.occurrences++;
      if (kind === "quotation") bucket.quotedOccurrences++;
    }
    if (matched) bucket.matchedPosts++;
  }
  const result = CorpusPeriodResultSchema.parse({
    schemaVersion: 1,
    projectorVersion: "corpus-periods-v1",
    manifest: input.manifest,
    family: manifest.family,
    scope: manifest.scope,
    window: manifest.window,
    exactCopies: manifest.exactCopies,
    periods,
    diagnostics,
    truncated: !manifest.scope.complete,
    caveats: [
      COVERAGE_CAVEAT,
      "Denominators contain validated completed extractions, including zero-claim results, not every archived post.",
      "Counts concern accepted extracted occurrences and the explicitly supplied family membership; candidate/rejection counts expose known extraction losses.",
      "Identical source text is reported as a copy, not proof of a repost or an independent assertion. Quoted occurrences are counted separately.",
      "Changed sample composition or unknown extraction coverage prevents inference about population prevalence.",
      "Scope completeness is declared by the manifest author; this projection does not independently enumerate the sampling frame.",
    ],
  });
  const hash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  const ref = await input.content.write(
    `corpus-periods/${hash}.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return { ref, result };
}
