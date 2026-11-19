import { createHash } from "node:crypto";
import { z } from "zod";
import { toArchiveRef } from "../collection/fulltext-projection.js";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import { ArtifactStoreError, type GitArtifactStore } from "../controllers/artifact-store.js";
import { DRAFT_VERIFIED_EVENT_TYPE_V1, type VerificationReport } from "../drafting/verify.js";

/**
 * Exact-artifact publication approval gate (#66).
 *
 * Two pure steps, around the publisher's state claim:
 *
 * 1. `parsePublishRequest` validates the trusted verifier's `draft.verified`
 *    event (message shape and provenance only) and turns an approval into an
 *    immutable publish request keyed by destination, commit and path. It
 *    rejects anything but an approval, and backfill unless backfill
 *    publication is explicitly enabled (it is disabled by default).
 *    No article bytes are loaded here.
 * 2. After the publisher claims that key, `verifyApprovedArtifact` reads the
 *    exact committed draft and verification report through the archive and
 *    checks reference integrity: the bytes match their hashes, and the
 *    report approves exactly this draft. A changed draft never inherits an
 *    earlier approval.
 *
 * This is not another editorial review: the model verification is not
 * repeated, and no Substack or state-store access happens here.
 */

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

const DraftVerifiedEventSchema = z
  .looseObject({
    specversion: z.literal("1.0"),
    id: z.string().min(1).max(200),
    source: z.string().min(1).max(500),
    type: z.literal(DRAFT_VERIFIED_EVENT_TYPE_V1),
    subject: z.string().min(1).max(500),
    data: z
      .object({
        publicationId: Id,
        postId: Id,
        ingestionReason: z.enum(["live", "backfill", "reprocess"]),
        verdict: z.enum(["approve", "redraft", "skip"]),
        draft: ArtifactReferenceSchema,
        report: ArtifactReferenceSchema,
      })
      .strict(),
  })
  .refine((e) => e.subject === `substack/${e.data.publicationId}/${e.data.postId}`, {
    message: "subject does not match the post",
  });

export const PublishRequestSchema = z
  .object({
    /** Stable publication key: destination, approved commit and path. */
    key: z.string().min(1),
    destination: z.string().min(1).max(200),
    publicationId: Id,
    postId: Id,
    ingestionReason: z.enum(["live", "backfill", "reprocess"]),
    draft: ArtifactReferenceSchema,
    report: ArtifactReferenceSchema,
    approvalEventId: z.string().min(1),
  })
  .strict();
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export type ApprovalRejection =
  | "malformed-event"
  | "not-approved"
  | "backfill-disabled"
  | "missing-artifact"
  | "tampered-content"
  | "stale-approval"
  | "invalid-report"
  | "archive-unavailable";

const ReportRefSchema = z
  .object({
    path: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

/** The fields of a verification report this gate relies on, validated at runtime. */
const ApprovalReportSchema = z.looseObject({
  schemaVersion: z.literal(1),
  verdict: z.enum(["approve", "redraft", "skip"]),
  draft: ReportRefSchema,
  brief: ReportRefSchema,
  issues: z.array(
    z.looseObject({
      source: z.enum(["deterministic", "verifier"]),
      passage: z.string().optional(),
      problem: z.string(),
      requiredChange: z.string(),
    }),
  ),
  attempt: z.number().int().min(1),
  maxAttempts: z.number().int().min(1),
  rejectedIssues: z.number().int().min(0),
});

export type ParseOutcome =
  | { ok: true; request: PublishRequest }
  | { ok: false; reason: ApprovalRejection };

/** Step 1: validate the approval event into a publish request (pure). */
export function parsePublishRequest(
  event: unknown,
  options: { destination: string; allowBackfill?: boolean },
): ParseOutcome {
  const parsed = DraftVerifiedEventSchema.safeParse(event);
  if (!parsed.success) return { ok: false, reason: "malformed-event" };
  const d = parsed.data.data;
  if (d.verdict !== "approve") return { ok: false, reason: "not-approved" };
  // Backfill never publishes automatically unless explicitly enabled.
  if (d.ingestionReason === "backfill" && options.allowBackfill !== true) {
    return { ok: false, reason: "backfill-disabled" };
  }
  const request = PublishRequestSchema.parse({
    key: `publish:${options.destination}:${d.draft.repository}:${d.draft.commit}:${d.draft.path}`,
    destination: options.destination,
    publicationId: d.publicationId,
    postId: d.postId,
    ingestionReason: d.ingestionReason,
    draft: d.draft,
    report: d.report,
    approvalEventId: parsed.data.id,
  });
  return { ok: true, request };
}

export type ArtifactCheck =
  | { ok: true; markdown: string; report: VerificationReport }
  | { ok: false; reason: ApprovalRejection; retryable: boolean };

/**
 * Step 2, after the publisher holds the publication key: read the exact
 * committed draft and report and check that the report approves exactly
 * these bytes.
 */
export async function verifyApprovedArtifact(
  request: PublishRequest,
  artifacts: Pick<GitArtifactStore, "read">,
): Promise<ArtifactCheck> {
  let markdown: string;
  let reportText: string;
  try {
    markdown = await artifacts.read(toArchiveRef(request.draft));
    reportText = await artifacts.read(toArchiveRef(request.report));
  } catch (error) {
    if (error instanceof ArtifactStoreError) {
      if (error.code === "hash-mismatch")
        return { ok: false, reason: "tampered-content", retryable: false };
      if (error.code === "not-found")
        return { ok: false, reason: "missing-artifact", retryable: false };
    }
    return { ok: false, reason: "archive-unavailable", retryable: true };
  }
  // Defence in depth: the bytes must hash to the approved reference.
  if (`sha256:${createHash("sha256").update(markdown).digest("hex")}` !== request.draft.hash) {
    return { ok: false, reason: "tampered-content", retryable: false };
  }
  // The archived report crosses a trust boundary: validate its shape.
  let report: VerificationReport;
  try {
    report = ApprovalReportSchema.parse(JSON.parse(reportText)) as unknown as VerificationReport;
  } catch {
    return { ok: false, reason: "invalid-report", retryable: false };
  }
  if (report.verdict !== "approve") return { ok: false, reason: "not-approved", retryable: false };
  // The approval must be for exactly this draft, at exactly this path and commit.
  if (
    report.draft?.hash !== request.draft.hash ||
    report.draft?.path !== request.draft.path ||
    report.draft?.commit !== request.draft.commit
  ) {
    return { ok: false, reason: "stale-approval", retryable: false };
  }
  return { ok: true, markdown, report };
}
