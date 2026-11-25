import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type {
  ArtifactRef,
  GitArtifactStore,
} from "../controllers/artifact-store.js";
import { ArtifactStoreError } from "../controllers/artifact-store.js";
import type {
  OperationClaim,
  OperationStore,
} from "../controllers/operation-store.js";
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
export const RetainedResearchRecoverySchema = z
  .object({
    version: z.literal("retained-length-limit-v1"),
    discovery: Ref,
    failedResult: Ref,
  })
  .strict();

export const ResearchRequestSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_JOB_SCHEMA_VERSION),
    /**
     * `extraction`: derived from a saved analysis, with exact post, analysis
     * and claim references. `theme` (#658): targeted enhancement of an
     * established theme's saved research, identified by the theme and the
     * claims needing evidence only, never by a post or byline.
     * `manual`: an operator's subject and optional brief
     * (#218), with its own stable input identity.
     */
    origin: z.enum(["extraction", "manual", "theme"]),
    /** Manual requests: the human-provided subject. */
    subject: z.string().trim().min(1).max(300).optional(),
    /** Manual requests: an optional brief explaining the narrative to research. */
    brief: z.string().trim().min(1).max(8000).optional(),
    /** 1 for the first pass; a second pass names the job it follows. */
    pass: z.number().int().min(1).max(5),
    previousJobId: JobId.optional(),
    retainedRecovery: RetainedResearchRecoverySchema.optional(),
    /** Extraction-derived requests point at an exact post and analysis; manual ones may not. */
    post: z
      .object({
        publicationId: z.string().min(1),
        postId: z.string().min(1),
        sourceArtifact: Ref,
        sourceContext: Ref.optional(),
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
            // A 2,000-character claim plus its reporting-period note (#889).
            statement: z.string().min(1).max(3000),
            themeIds: z.array(z.string().min(1)).max(30),
          })
          .strict(),
      )
      .max(100),
    /**
     * Claims of this theme left out of the request by the per-request claim
     * cap (#533), in priority order. Recorded for audit; not part of the job
     * identity. They stay explicit gaps in coverage.
     */
    omittedClaimRecordIds: z
      .array(z.string().min(1).max(200))
      .max(500)
      .optional(),
    /** The question or gap the research must resolve (optional for a manual subject request). */
    question: z.string().trim().min(1).max(4000).optional(),
    /** Existing corpus material the researcher should start from. */
    corpusRefs: z.array(Ref).max(100),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.pass > 1 && !r.previousJobId) {
      ctx.addIssue({
        code: "custom",
        message: "a later pass must name the job it follows",
      });
    }
    const ids = r.claims.map((c) => c.claimRecordId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        message: "claims must not repeat a claim record ID",
      });
    }
    if (r.pass === 1 && r.previousJobId) {
      ctx.addIssue({
        code: "custom",
        message: "a first pass has no previous job",
      });
    }
    if (r.origin === "extraction") {
      if (!r.post || r.claims.length === 0 || !r.question) {
        ctx.addIssue({
          code: "custom",
          message:
            "an extraction request needs exact post and analysis references, claims and a question",
        });
      }
      if (r.subject || r.brief) {
        ctx.addIssue({
          code: "custom",
          message: "subject and brief are for manual requests",
        });
      }
    } else if (r.origin === "theme") {
      if (
        r.post ||
        r.subject ||
        r.brief ||
        r.claims.length === 0 ||
        !r.question
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "a theme request names claims and a question only, with no post, subject or brief",
        });
      }
      const themes = new Set(r.claims.flatMap((c) => c.themeIds));
      if (themes.size !== 1) {
        ctx.addIssue({
          code: "custom",
          message: "a theme request targets exactly one theme",
        });
      }
    } else {
      if (!r.subject)
        ctx.addIssue({
          code: "custom",
          message: "a manual request needs a subject",
        });
      if (r.post)
        ctx.addIssue({
          code: "custom",
          message: "a manual request has no post analysis",
        });
    }
  });
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

export const ResearchOutcomeSchema = z.enum([
  "complete",
  "complete-with-gaps",
  "failed",
]);
export type ResearchOutcome = z.infer<typeof ResearchOutcomeSchema>;

export const CitationRecordSchema = z
  .object({
    url: z.url({ protocol: /^https?$/ }),
    retrieval: z.enum([
      "archived",
      "inaccessible",
      "unsupported",
      "not-attempted",
    ]),
    /** Sanitised reason when not archived, e.g. "redirected", "unsupported-content", "timeout". */
    retrievalReason: z.string().max(100).optional(),
    archivedArtifact: Ref.optional(),
    /**
     * `supported`: an archived passage directly supports the attributed finding.
     * `unverified`: retrieved, but only topical or uncertain. `not-checked`: no support check ran.
     */
    support: z.enum(["supported", "unverified", "not-checked"]).optional(),
    sourceType: z.string().max(100).optional(),
    confidenceRationale: z.string().max(2000).optional(),
    /** Writer hint from the bundle assessment (#795): 1 is the most responsive source. */
    relevanceRank: z.number().int().min(1).max(500).optional(),
    /** Writer hint: one line on what this source is useful for. */
    writerNote: z.string().min(1).max(500).optional(),
    /** Claim-specific supporting passages in the archived source. */
    passages: z
      .array(
        z
          .object({
            claimRecordId: z.string().min(1),
            passage: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

/** Technical incompleteness is explicit and never independent factual support. */
export const ResearchWarningSchema = z
  .object({
    code: z.literal("report-output-limit"),
    discovery: Ref,
    message: z.literal(
      "The provider report reached its output limit; retained text and source links are partial.",
    ),
  })
  .strict();
export const ResearchWarningsSchema = z.array(ResearchWarningSchema).max(1);
export type ResearchWarning = z.infer<typeof ResearchWarningSchema>;
export const outputLimitWarning = (
  discovery: z.infer<typeof Ref>,
): ResearchWarning => ({
  code: "report-output-limit",
  discovery,
  message:
    "The provider report reached its output limit; retained text and source links are partial.",
});

export const ResearchManifestSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_JOB_SCHEMA_VERSION),
    jobId: JobId,
    report: Ref,
    discovery: Ref.optional(),
    retainedRecovery: RetainedResearchRecoverySchema.optional(),
    coveringNote: Ref.optional(),
    warnings: ResearchWarningsSchema.optional(),
    citations: z.array(CitationRecordSchema).max(500),
    gaps: z.array(z.string().min(1).max(2000)).max(100),
    /** Writer orientation from the bundle assessment (#795). */
    writerBrief: z.string().min(1).max(2000).optional(),
    provider: z
      .object({ model: z.string().min(1), costUsd: z.number().optional() })
      .strict(),
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
      .enum([
        "provider-error",
        "timeout",
        "interrupted",
        "invalid-report",
        "budget-exceeded",
      ])
      .optional(),
    warnings: ResearchWarningsSchema.optional(),
    finishedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.warnings?.length && r.outcome !== "complete-with-gaps")
      ctx.addIssue({
        code: "custom",
        message: "partial research must retain gaps",
      });
    if (r.outcome !== "failed" && !r.manifest) {
      ctx.addIssue({
        code: "custom",
        message: "a completed job must reference its manifest",
      });
    }
    if (r.outcome === "failed" && !r.failure) {
      ctx.addIssue({ code: "custom", message: "a failed job must state why" });
    }
  });
export type ResearchResult = z.infer<typeof ResearchResultSchema>;

const refKey = (r: {
  repository: string;
  commit: string;
  path: string;
  hash: string;
}) => [r.repository, r.commit, r.path, r.hash];

/** Stable job ID from the immutable inputs and pass. */
export function researchJobId(input: unknown): string {
  const r = ResearchRequestSchema.parse(input);
  const canonical = JSON.stringify({
    v: r.schemaVersion,
    origin: r.origin,
    subject: r.subject
      ? r.subject.normalize("NFKC").replace(/\s+/g, " ").trim()
      : null,
    brief: r.brief
      ? r.brief.normalize("NFKC").replace(/\s+/g, " ").trim()
      : null,
    pass: r.pass,
    previous: r.previousJobId ?? null,
    ...(r.retainedRecovery
      ? {
          retainedRecovery: [
            r.retainedRecovery.version,
            refKey(r.retainedRecovery.discovery),
            refKey(r.retainedRecovery.failedResult),
            r.post?.sourceContext ? refKey(r.post.sourceContext) : null,
          ],
        }
      : {}),
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
      .map((c) =>
        JSON.stringify([c.claimRecordId, c.statement, [...c.themeIds].sort()]),
      )
      .sort(),
    question: r.question
      ? r.question.normalize("NFKC").replace(/\s+/g, " ").trim()
      : null,
    corpus: r.corpusRefs
      .map(refKey)
      .sort((a, b) => a.join().localeCompare(b.join())),
  });
  return `research-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export class InvalidResearchManifestError extends Error {
  constructor(reason: string) {
    super(`research manifest rejected: ${reason}`);
    this.name = "InvalidResearchManifestError";
  }
}

export const researchJobPath = (
  jobId: string,
  file: "request" | "result" | "manifest",
) => `research-jobs/${JobId.parse(jobId)}/${file}.json`;

const asReference = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

export async function writeOnce(
  store: GitArtifactStore,
  path: string,
  value: unknown,
): Promise<ArtifactRef> {
  const content =
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
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
/** How long one provider run may hold a job before another caller may treat it as interrupted. */
export const DEFAULT_RUN_LEASE_MS = 30 * 60_000;

export type OpenedResearchJob =
  | {
      status: "run";
      jobId: string;
      requestRef: ArtifactRef;
      owner: string;
      claim: OperationClaim;
      leaseMs: number;
    }
  | {
      status: "finished";
      jobId: string;
      requestRef: ArtifactRef;
      existing: ResearchResult;
    }
  | { status: "busy"; jobId: string; requestRef: ArtifactRef };

/**
 * Save a request and decide what the caller may do. Only one caller at a
 * time receives `run` (a leased state-controller claim), so the provider is
 * never called twice for one job. A redelivered request for a finished job
 * returns its saved outcome. A run whose holder disappeared (lease expired)
 * is not retried: it is recorded as failed (`interrupted`), keeping the
 * fail-fast, no-automatic-retry rule.
 */
export async function openResearchJob(input: {
  artifacts: GitArtifactStore;
  operations: OperationStore;
  request: unknown;
  owner: string;
  leaseMs?: number;
  now?: () => Date;
}): Promise<OpenedResearchJob> {
  const request = ResearchRequestSchema.parse(input.request);
  const jobId = researchJobId(request);
  const requestRef = await writeOnce(
    input.artifacts,
    researchJobPath(jobId, "request"),
    request,
  );
  const resultRef = await input.artifacts.lookup(
    researchJobPath(jobId, "result"),
  );
  if (resultRef) {
    const existing = ResearchResultSchema.parse(
      JSON.parse(await input.artifacts.read(resultRef)),
    );
    // Ensure the completion is recorded even if an earlier run stopped between saving and recording.
    recordOutcome(input.operations, jobId, existing);
    return { status: "finished", jobId, requestRef, existing };
  }
  const claim = input.operations.claim(
    `research-run:${jobId}`,
    input.owner,
    input.leaseMs ?? DEFAULT_RUN_LEASE_MS,
    1,
  );
  if (claim.kind === "claimed") {
    return {
      status: "run",
      jobId,
      requestRef,
      owner: input.owner,
      claim: claim.claim,
      leaseMs: input.leaseMs ?? DEFAULT_RUN_LEASE_MS,
    };
  }
  if (claim.kind === "busy") return { status: "busy", jobId, requestRef };
  // Exhausted (the single attempt's holder vanished) or a stale completion
  // without a saved result: record an interrupted failure, never re-run.
  const { result } = await finishResearchJob({
    artifacts: input.artifacts,
    operations: input.operations,
    jobId,
    outcome: "failed",
    failure: "interrupted",
    ...(input.now ? { now: input.now } : {}),
  });
  return { status: "finished", jobId, requestRef, existing: result };
}

function recordOutcome(
  operations: OperationStore,
  jobId: string,
  result: ResearchResult,
): void {
  if (operations.pendingEventStatus(jobId) !== undefined) return;
  const event = createResearchCompletedEvent(
    {
      jobId,
      outcome: result.outcome,
      ...(result.manifest ? { manifest: result.manifest } : {}),
    },
    { id: jobId, now: () => new Date(result.finishedAt) },
  );
  operations.reconcileCompleted(
    `research:${jobId}`,
    { jobId, outcome: result.outcome },
    [
      {
        eventId: jobId,
        subject: RESEARCH_COMPLETED_SUBJECT,
        payload: JSON.stringify(event.toJSON()),
      },
    ],
  );
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
  warnings?: ResearchWarning[];
  now?: () => Date;
}): Promise<{
  result: ResearchResult;
  resultRef: ArtifactRef;
  reused: boolean;
}> {
  const path = researchJobPath(input.jobId, "result");
  const saved = await input.artifacts.lookup(path);
  if (saved) {
    const result = ResearchResultSchema.parse(
      JSON.parse(await input.artifacts.read(saved)),
    );
    recordOutcome(input.operations, input.jobId, result);
    return { result, resultRef: saved, reused: true };
  }
  let manifestWarnings: ResearchWarning[] | undefined;
  // A manifest must be valid and belong to this job before completion is committed.
  if (input.manifest) {
    let manifest;
    try {
      manifest = ResearchManifestSchema.parse(
        JSON.parse(await input.artifacts.read(input.manifest)),
      );
    } catch {
      throw new InvalidResearchManifestError(
        "manifest is unreadable or invalid",
      );
    }
    manifestWarnings = manifest.warnings;
    if (
      input.warnings &&
      JSON.stringify(input.warnings) !== JSON.stringify(manifestWarnings)
    )
      throw new InvalidResearchManifestError("warnings disagree with manifest");
    if (manifest.jobId !== input.jobId) {
      throw new InvalidResearchManifestError("manifest belongs to another job");
    }
  }
  const result = ResearchResultSchema.parse({
    schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
    jobId: input.jobId,
    outcome: input.outcome,
    ...(input.manifest ? { manifest: asReference(input.manifest) } : {}),
    ...(input.failure ? { failure: input.failure } : {}),
    ...(manifestWarnings?.length ? { warnings: manifestWarnings } : {}),
    finishedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  const resultRef = await writeOnce(input.artifacts, path, result);
  const stored = ResearchResultSchema.parse(
    JSON.parse(await input.artifacts.read(resultRef)),
  );
  recordOutcome(input.operations, input.jobId, stored);
  return {
    result: stored,
    resultRef,
    reused: stored.finishedAt !== result.finishedAt,
  };
}
