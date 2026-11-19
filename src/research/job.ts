import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { ArtifactStoreError } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  RESEARCH_COMPLETED_SUBJECT,
  createResearchCompletedEvent,
} from "../events/research-completed-event.js";

/**
 * Durable research job contracts (#215; design: doc/architecture/18-module-outline.md,
 * "Implementation defaults").
 *
 * A request carries exact post, analysis and claim references, the claims'
 * theme links, the research question and any relevant corpus references. Its
 * job ID is derived from those immutable inputs and the research pass, so a
 * redelivered request reuses the same job; a librarian-directed second pass
 * gets a new ID that records the first job. A job ends as `complete`,
 * `complete-with-gaps` or `failed`; the outcome and a lightweight completion
 * event are persisted together through the state controller's outbox before
 * work is acknowledged, and redelivery never schedules another provider call.
 */

export const RESEARCH_JOB_SCHEMA_VERSION = 1;

const Ref = ArtifactReferenceSchema;
const JobId = z.string().regex(/^research-[0-9a-f]{32}$/);

export const ResearchRequestSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_JOB_SCHEMA_VERSION),
    /** 1 for the first pass; a second pass names the job it follows. */
    pass: z.number().int().min(1).max(5),
    previousJobId: JobId.optional(),
    /** Extraction-derived requests point at an exact post and analysis; manual ones may not. */
    post: z
      .object({
        publicationId: z.string().min(1),
        postId: z.string().min(1),
        sourceArtifact: Ref,
        themeResult: Ref,
        claimResult: Ref,
      })
      .strict()
      .optional(),
    claims: z
      .array(
        z
          .object({
            claimRecordId: z.string().min(1).max(200),
            statement: z.string().min(1).max(2000),
            themeIds: z.array(z.string().min(1)).max(30),
          })
          .strict(),
      )
      .max(100),
    /** The question or gap the research must resolve. */
    question: z.string().trim().min(1).max(4000),
    /** Existing corpus material the researcher should start from. */
    corpusRefs: z.array(Ref).max(100),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.pass > 1 && !r.previousJobId) {
      ctx.addIssue({ code: "custom", message: "a later pass must name the job it follows" });
    }
    if (r.pass === 1 && r.previousJobId) {
      ctx.addIssue({ code: "custom", message: "a first pass has no previous job" });
    }
  });
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

export const ResearchOutcomeSchema = z.enum(["complete", "complete-with-gaps", "failed"]);
export type ResearchOutcome = z.infer<typeof ResearchOutcomeSchema>;

export const CitationRecordSchema = z
  .object({
    url: z.url({ protocol: /^https?$/ }),
    retrieval: z.enum(["archived", "inaccessible", "unsupported", "not-attempted"]),
    archivedArtifact: Ref.optional(),
    sourceType: z.string().max(100).optional(),
    confidenceRationale: z.string().max(2000).optional(),
    /** Claim-specific supporting passages in the archived source. */
    passages: z
      .array(
        z
          .object({ claimRecordId: z.string().min(1), passage: z.string().min(1).max(4000) })
          .strict(),
      )
      .max(50),
  })
  .strict();

export const ResearchManifestSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_JOB_SCHEMA_VERSION),
    jobId: JobId,
    report: Ref,
    coveringNote: Ref.optional(),
    citations: z.array(CitationRecordSchema).max(500),
    gaps: z.array(z.string().min(1).max(2000)).max(100),
    provider: z.object({ model: z.string().min(1), costUsd: z.number().optional() }).strict(),
  })
  .strict();
export type ResearchManifest = z.infer<typeof ResearchManifestSchema>;

export const ResearchResultSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_JOB_SCHEMA_VERSION),
    jobId: JobId,
    outcome: ResearchOutcomeSchema,
    /** Present whenever a report exists (complete or complete-with-gaps). */
    manifest: Ref.optional(),
    /** Sanitised failure code; never provider payloads or credentials. */
    failure: z
      .enum(["provider-error", "timeout", "interrupted", "invalid-report", "budget-exceeded"])
      .optional(),
    finishedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.outcome !== "failed" && !r.manifest) {
      ctx.addIssue({ code: "custom", message: "a completed job must reference its manifest" });
    }
    if (r.outcome === "failed" && !r.failure) {
      ctx.addIssue({ code: "custom", message: "a failed job must state why" });
    }
  });
export type ResearchResult = z.infer<typeof ResearchResultSchema>;

const refKey = (r: { repository: string; commit: string; path: string; hash: string }) => [
  r.repository,
  r.commit,
  r.path,
  r.hash,
];

/** Stable job ID from the immutable inputs and pass. */
export function researchJobId(input: unknown): string {
  const r = ResearchRequestSchema.parse(input);
  const canonical = JSON.stringify({
    v: r.schemaVersion,
    pass: r.pass,
    previous: r.previousJobId ?? null,
    post: r.post
      ? [
          r.post.publicationId,
          r.post.postId,
          refKey(r.post.sourceArtifact),
          refKey(r.post.themeResult),
          refKey(r.post.claimResult),
        ]
      : null,
    claims: [...r.claims]
      .map((c) => [c.claimRecordId, c.statement, [...c.themeIds].sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    question: r.question.normalize("NFKC").replace(/\s+/g, " ").trim(),
    corpus: r.corpusRefs.map(refKey).sort((a, b) => a.join().localeCompare(b.join())),
  });
  return `research-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export const researchJobPath = (jobId: string, file: "request" | "result" | "manifest") =>
  `research-jobs/${JobId.parse(jobId)}/${file}.json`;

const asReference = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

async function writeOnce(
  store: GitArtifactStore,
  path: string,
  value: unknown,
): Promise<ArtifactRef> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  for (let attempt = 0; ; attempt++) {
    try {
      return await store.write(path, content);
    } catch (error) {
      const code = error instanceof ArtifactStoreError ? error.code : undefined;
      if (code === "concurrent-update" && attempt < 5) continue;
      if (code === "immutable-conflict") {
        // Same path, different content: the job already recorded something else.
        const existing = await store.lookup(path);
        if (existing) return existing;
      }
      throw error;
    }
  }
}

/**
 * Save a request and return its job identity. Redelivery of the same request
 * reuses the saved job: `existing` reports an earlier terminal outcome so the
 * caller never runs the provider again.
 */
export async function openResearchJob(input: {
  artifacts: GitArtifactStore;
  operations: OperationStore;
  request: unknown;
}): Promise<{ jobId: string; requestRef: ArtifactRef; existing?: ResearchResult }> {
  const request = ResearchRequestSchema.parse(input.request);
  const jobId = researchJobId(request);
  const requestRef = await writeOnce(input.artifacts, researchJobPath(jobId, "request"), request);
  const resultRef = await input.artifacts.lookup(researchJobPath(jobId, "result"));
  if (resultRef) {
    const existing = ResearchResultSchema.parse(JSON.parse(await input.artifacts.read(resultRef)));
    // Ensure the completion is recorded even if an earlier run stopped between saving and recording.
    recordOutcome(input.operations, jobId, existing);
    return { jobId, requestRef, existing };
  }
  return { jobId, requestRef };
}

function recordOutcome(operations: OperationStore, jobId: string, result: ResearchResult): void {
  if (operations.pendingEventStatus(jobId) !== undefined) return;
  const event = createResearchCompletedEvent(
    { jobId, outcome: result.outcome, ...(result.manifest ? { manifest: result.manifest } : {}) },
    { id: jobId, now: () => new Date(result.finishedAt) },
  );
  operations.reconcileCompleted(`research:${jobId}`, { jobId, outcome: result.outcome }, [
    {
      eventId: jobId,
      subject: RESEARCH_COMPLETED_SUBJECT,
      payload: JSON.stringify(event.toJSON()),
    },
  ]);
}

/**
 * Persist a job's terminal outcome (write-once) and its completion event in
 * the outbox. Repeating with the same job returns the saved outcome; a
 * different outcome for a finished job is refused rather than overwritten.
 */
export async function finishResearchJob(input: {
  artifacts: GitArtifactStore;
  operations: OperationStore;
  jobId: string;
  outcome: ResearchOutcome;
  manifest?: ArtifactRef;
  failure?: ResearchResult["failure"];
  now?: () => Date;
}): Promise<{ result: ResearchResult; resultRef: ArtifactRef; reused: boolean }> {
  const path = researchJobPath(input.jobId, "result");
  const saved = await input.artifacts.lookup(path);
  if (saved) {
    const result = ResearchResultSchema.parse(JSON.parse(await input.artifacts.read(saved)));
    recordOutcome(input.operations, input.jobId, result);
    return { result, resultRef: saved, reused: true };
  }
  const result = ResearchResultSchema.parse({
    schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
    jobId: input.jobId,
    outcome: input.outcome,
    ...(input.manifest ? { manifest: asReference(input.manifest) } : {}),
    ...(input.failure ? { failure: input.failure } : {}),
    finishedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  const resultRef = await writeOnce(input.artifacts, path, result);
  const stored = ResearchResultSchema.parse(JSON.parse(await input.artifacts.read(resultRef)));
  recordOutcome(input.operations, input.jobId, stored);
  return { result: stored, resultRef, reused: stored.finishedAt !== result.finishedAt };
}
