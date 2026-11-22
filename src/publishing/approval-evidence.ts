import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  OwnerDraftAuthorizationSchema,
  ownerDraftRequestHash,
  ownerDraftVersionIdentity,
  type DraftTarget,
} from "../content/owner-draft-authorization.js";
import { DraftRehearsalError, readRetainedDraftRehearsal } from "../drafting/draft-rehearsal.js";
import { approvedArticleEventId } from "./approved-article.js";
import { AssessmentRecordSchema, classifyFindings } from "../drafting/article-assessment.js";
import { JudgmentRecordSchema, readDecision } from "../drafting/editorial-judgment.js";
import { PackageVerificationReportSchema, approvalValidFor } from "../drafting/package-verify.js";
import {
  artifactRef,
  readPublicationPayload,
  sameArtifact,
  type PublicationPayload,
} from "../drafting/publication-payload.js";

export type ApprovalKind = "combined-verification" | "editorial-judgment" | "owner-draft-rehearsal";
export interface ApprovalEvidence {
  kind: ApprovalKind;
  post: { publicationId: string; postId: string };
  body: ArtifactReference;
  package: ArtifactReference;
  publication?: ArtifactReference;
  assessment?: ArtifactReference;
  approvedAt: string;
  markdown: string;
  payload?: PublicationPayload;
  draftTargets?: DraftTarget[];
  authorizationOutcome?: "owner-authorized-draft";
}
export class ApprovalEvidenceError extends Error {
  constructor(reason = "approval does not match the draft") {
    super(`approval rejected: ${reason}`);
  }
}

/** Re-read exact evidence at both outbox creation and delivery. No model calls. */
export async function readApprovalEvidence(
  content: Pick<GitArtifactStore, "read">,
  ref: ArtifactRef,
  kind: ApprovalKind = "combined-verification",
  operations?: Pick<OperationStore, "ownerDraftAuthorization" | "editorialRecoveryAttempt">,
): Promise<ApprovalEvidence> {
  const raw = JSON.parse(await content.read(ref));
  if (kind === "owner-draft-rehearsal") {
    if (!operations) throw new ApprovalEvidenceError();
    const owner = OwnerDraftAuthorizationSchema.parse(raw);
    const eventId = approvedArticleEventId(artifactRef(owner.request.body), ref);
    const binding = operations.ownerDraftAuthorization(eventId);
    const hash = ownerDraftRequestHash(owner.request);
    if (
      !binding ||
      !sameArtifact(binding.authorization, {
        repository: ref.repository,
        commit: ref.commit,
        path: ref.path,
        hash: `sha256:${ref.sha256}`,
      }) ||
      binding.binding.requestHash !== hash ||
      binding.binding.versionIdentity !== ownerDraftVersionIdentity(owner.request) ||
      binding.binding.requestId !== owner.request.requestId ||
      binding.binding.recordedAt !== owner.authorizedAt ||
      binding.binding.publicationId !== owner.post.publicationId ||
      binding.binding.postId !== owner.post.postId
    )
      throw new ApprovalEvidenceError();
    let retained;
    try {
      retained = await readRetainedDraftRehearsal({ request: owner.request, content, operations });
    } catch (error) {
      if (error instanceof DraftRehearsalError) throw new ApprovalEvidenceError();
      throw error;
    }
    if (
      retained.post.publicationId !== owner.post.publicationId ||
      retained.post.postId !== owner.post.postId
    )
      throw new ApprovalEvidenceError();
    return {
      kind,
      post: owner.post,
      body: owner.request.body,
      package: owner.request.package,
      publication: owner.request.publication,
      assessment: owner.request.assessment,
      approvedAt: owner.authorizedAt,
      markdown: retained.markdown,
      payload: retained.payload,
      draftTargets: owner.request.destinations,
      authorizationOutcome: owner.outcome,
    };
  }
  const postFor = async (packageRef: ArtifactReference) =>
    z
      .object({
        post: z.object({
          publicationId: z.string().min(1).max(200),
          postId: z.string().min(1).max(200),
        }),
      })
      .parse(JSON.parse(await content.read(artifactRef(packageRef)))).post;
  if (kind === "combined-verification") {
    const report = PackageVerificationReportSchema.parse(raw);
    if (report.outcome !== "approved")
      throw new ApprovalEvidenceError("report does not approve the draft");
    const markdown = await content.read(artifactRef(report.draft));
    const loaded =
      report.schemaVersion === 2
        ? {
            ref: report.publication,
            ...(await readPublicationPayload(content, report.publication)),
          }
        : undefined;
    if (!approvalValidFor(report, markdown, loaded)) throw new ApprovalEvidenceError();
    return {
      kind,
      post: await postFor(report.package),
      body: report.draft,
      package: report.package,
      approvedAt: report.verifiedAt,
      markdown,
      ...(loaded ? { publication: loaded.ref, payload: loaded.payload } : {}),
    };
  }
  const judgment = JudgmentRecordSchema.parse(raw);
  if (
    judgment.operationalFailure !== undefined ||
    judgment.state !== "decided" ||
    judgment.decision !== "approve" ||
    judgment.gates.length ||
    !judgment.document ||
    !judgment.judge?.model.trim() ||
    !judgment.judge.promptVersion.trim()
  )
    throw new ApprovalEvidenceError();
  if (readDecision(await content.read(artifactRef(judgment.document))) !== "approve")
    throw new ApprovalEvidenceError();
  const assessment = AssessmentRecordSchema.parse(
    JSON.parse(await content.read(artifactRef(judgment.assessment))),
  );
  if (
    assessment.operationalFailure !== undefined ||
    !assessment.document ||
    !assessment.assessor.model.trim() ||
    !assessment.assessor.promptVersion.trim() ||
    assessment.deterministicFindings.length ||
    !sameArtifact(assessment.body, judgment.body) ||
    !sameArtifact(assessment.publication, judgment.publication)
  )
    throw new ApprovalEvidenceError();
  const classified = classifyFindings(await content.read(artifactRef(assessment.document)));
  if (
    (classified.state !== "findings" && classified.state !== "no-faults") ||
    classified.state !== assessment.state ||
    classified.findings !== assessment.findings
  )
    throw new ApprovalEvidenceError();
  const loaded = await readPublicationPayload(content, judgment.publication);
  if (!sameArtifact(loaded.payload.body, judgment.body)) throw new ApprovalEvidenceError();
  return {
    kind,
    post: await postFor(assessment.package),
    body: judgment.body,
    package: assessment.package,
    assessment: judgment.assessment,
    publication: judgment.publication,
    approvedAt: judgment.decidedAt,
    markdown: loaded.markdown,
    payload: loaded.payload,
  };
}
