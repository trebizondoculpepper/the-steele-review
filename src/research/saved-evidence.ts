import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { writeOnce } from "./job.js";
import { CoverageRecordSchema, type CoverageRecord } from "./librarian.js";

/**
 * Hand-selected evidence from saved research (#261).
 *
 * Derives a new coverage record from an existing one in which one claim cites
 * one passage, quoted verbatim from a source snapshot that a finished research
 * job already archived. Nothing is researched, judged or invented here: the
 * job, its manifest citation, the archived snapshot and the passage are all
 * checked against the stored bytes, and the selection is recorded in the
 * claim's `reason`. Every other claim keeps its original outcome, so gaps stay
 * gaps. The result is an ordinary coverage record, so the normal writer
 * package is built from it and validated as usual.
 */

export class SavedEvidenceError extends Error {
  constructor(
    readonly code:
      | "unknown-claim"
      | "unknown-job"
      | "job-not-finished"
      | "citation-not-archived"
      | "monitored-source"
      | "passage-not-in-snapshot",
  ) {
    super(`saved evidence rejected: ${code}`);
    this.name = "SavedEvidenceError";
  }
}

const Ref = z.object({
  repository: z.string(),
  commit: z.string(),
  path: z.string(),
  hash: z.string(),
});
const ManifestSchema = z.object({
  jobId: z.string(),
  citations: z.array(z.object({ url: z.string(), archivedArtifact: Ref.optional() }).passthrough()),
});
const SnapshotSchema = z.object({ url: z.string(), text: z.string() }).passthrough();

const fromRef = (r: z.infer<typeof Ref>): ArtifactRef => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.hash.replace(/^sha256:/, ""),
});
const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

export async function selectSavedEvidence(input: {
  content: GitArtifactStore;
  coverage: ArtifactRef;
  claimRecordId: string;
  jobId: string;
  url: string;
  /** Verbatim from the archived snapshot (whitespace-insensitive match). */
  passage: string;
  /** Who selected it and why, kept with the claim. */
  note: string;
}): Promise<{ record: CoverageRecord; ref: ArtifactRef }> {
  const original = CoverageRecordSchema.parse(JSON.parse(await input.content.read(input.coverage)));
  const claim = original.claims.find((c) => c.claimRecordId === input.claimRecordId);
  if (!claim) throw new SavedEvidenceError("unknown-claim");
  const job = original.jobs.find((j) => j.jobId === input.jobId);
  if (!job?.manifest) throw new SavedEvidenceError("unknown-job");
  if (!job.outcome.startsWith("complete")) throw new SavedEvidenceError("job-not-finished");

  const manifest = ManifestSchema.parse(
    JSON.parse(await input.content.read(fromRef(job.manifest))),
  );
  const citation = manifest.citations.find((c) => c.url === input.url);
  if (!citation?.archivedArtifact) throw new SavedEvidenceError("citation-not-archived");
  // As in the librarian's own assessment, the monitored publication's material
  // can never independently cover its own claim.
  if (citation.sourceType === "monitored-source") throw new SavedEvidenceError("monitored-source");
  const snapshot = SnapshotSchema.parse(
    JSON.parse(await input.content.read(fromRef(citation.archivedArtifact))),
  );
  if (snapshot.url !== input.url || !normalise(snapshot.text).includes(normalise(input.passage)))
    throw new SavedEvidenceError("passage-not-in-snapshot");

  const record = CoverageRecordSchema.parse({
    ...original,
    claims: original.claims.map((c) =>
      c.claimRecordId === input.claimRecordId
        ? {
            ...c,
            status: "evidence-found",
            // Last, so the package resolves the snapshot from the selected job
            // (writer-package searches jobIds from the end).
            jobIds: [...c.jobIds.filter((j) => j !== input.jobId), input.jobId],
            citations: [{ url: input.url, passage: normalise(input.passage) }],
            reason: `hand-selected from saved research ${input.jobId} (archived snapshot); ${input.note}`,
          }
        : c,
    ),
  });
  const { publicationId, postId } = record.post;
  const key = createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 32);
  const ref = await writeOnce(
    input.content,
    `librarian/coverage/${publicationId}/${postId}/${key}.json`,
    record,
  );
  return { record, ref };
}
