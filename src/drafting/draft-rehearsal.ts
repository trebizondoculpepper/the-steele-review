import { z } from "zod";
import {
  OwnerDraftRequestSchema,
  type OwnerDraftRequest,
} from "../content/owner-draft-authorization.js";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import { JudgeRecoveryRunInputSchema } from "../content/editorial-judge-recovery-contract.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  loadJudgeRecoveryIntent,
  judgeRecoveryIntentHash,
} from "../workflow/editorial-judge-recovery-submission.js";
import { AssessmentRecordSchema, classifyFindings } from "./article-assessment.js";
import { JudgmentRecordSchema } from "./editorial-judgment.js";
import { parseJudgmentDocument } from "./judgment-document.js";
import { assertEditorialBaseCurrent } from "./editorial-continuation.js";
import {
  ModelDraftSchema,
  PackageDraftMetadataSchema,
  draftProblems,
  modelCitationProblems,
  renderPackageDraft,
} from "./package-draft.js";
import { WriterPackageSchema } from "./writer-package.js";
import { MechanicalRecordSchema } from "./mechanical-record.js";
import { WriterAttemptManifestSchema } from "./writer-attempts.js";
import {
  artifactRef,
  artifactReference,
  readPublicationPayload,
  sameArtifact,
} from "./publication-payload.js";

const Stored = ArtifactReferenceSchema.omit({ hash: true })
  .extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const Version = z.object({ draft: Stored, metadata: Stored }).strict();
const summarySchema = () =>
  z.object({
    version: z.literal("editorial-judge-recovery-history-v1"),
    workflowKey: z.string(),
    input: JudgeRecoveryRunInputSchema,
    outcome: z.literal("rejected"),
    approvalState: z.literal("absent"),
    draft: Stored,
    metadata: Stored,
    newCounts: z.object({
      revisionAttempts: z.literal(1),
      revisions: z.literal(1),
      assessments: z.number().int().min(1),
      judgments: z.number().int().min(1),
    }),
    editorial: z.object({
      initial: Version,
      revisions: z.array(Version).length(1),
      revisionAttempts: z.literal(1),
      assessments: z.array(Stored).min(1).max(6),
      judgments: z.array(Stored).min(1).max(6),
      mechanicalRuns: z.array(Stored).length(1),
      terminal: z.literal("unresolved"),
    }),
  });
export class DraftRehearsalError extends Error {
  constructor(
    readonly code:
      | "invalid-evidence"
      | "identity-conflict"
      | "parent-not-complete"
      | "target-refused",
  ) {
    super(`draft rehearsal: ${code}`);
    this.name = "DraftRehearsalError";
  }
}
const requireEvidence = (condition: unknown) => {
  if (!condition) throw new DraftRehearsalError("invalid-evidence");
};

/** No model capability. Recompute structural eligibility from exact retained artifacts. */
export async function readRetainedDraftRehearsal(input: {
  request: OwnerDraftRequest;
  content: Pick<GitArtifactStore, "read"> & Partial<Pick<GitArtifactStore, "lookup" | "lookupAt">>;
  operations: Pick<OperationStore, "editorialRecoveryAttempt">;
  requireCurrent?: boolean;
}) {
  const request = OwnerDraftRequestSchema.parse(input.request),
    { content } = input;
  const read = async (ref: ArtifactReference) => JSON.parse(await content.read(artifactRef(ref)));
  const summary = summarySchema().parse(await read(request.parent.summary));
  const eq = (stored: z.infer<typeof Stored>, selected: ArtifactReference) =>
    sameArtifact(artifactReference(stored), selected);
  requireEvidence(
    summary.workflowKey === request.parent.workflowKey &&
      eq(summary.draft, request.body) &&
      eq(summary.metadata, request.metadata),
  );
  requireEvidence(
    eq(summary.editorial.revisions[0]!.draft, request.body) &&
      eq(summary.editorial.revisions[0]!.metadata, request.metadata),
  );
  requireEvidence(
    eq(summary.editorial.assessments.at(-1)!, request.assessment) &&
      eq(summary.editorial.judgments.at(-1)!, request.judgment) &&
      eq(summary.editorial.mechanicalRuns[0]!, request.mechanicalRun),
  );
  const intent = await loadJudgeRecoveryIntent(content, summary.input);
  requireEvidence(sameArtifact(intent.seed.package, request.package));
  const loaded = await readPublicationPayload(content, request.publication);
  requireEvidence(
    loaded.payload.mode === "structured" &&
      sameArtifact(loaded.payload.body, request.body) &&
      sameArtifact(loaded.payload.metadata, request.metadata),
  );
  const pkg = WriterPackageSchema.parse(await read(request.package));
  const recorded = input.operations.editorialRecoveryAttempt(
    pkg.post.publicationId,
    pkg.post.postId,
    summary.input.requestId,
  );
  requireEvidence(
    recorded &&
      recorded.workflowKey === summary.workflowKey &&
      recorded.inputHash === judgeRecoveryIntentHash(intent) &&
      sameArtifact(recorded.intent, summary.input.intent),
  );
  const metadata = PackageDraftMetadataSchema.parse(await read(request.metadata));
  requireEvidence(
    !metadata.format &&
      metadata.mechanicalRun &&
      sameArtifact(metadata.mechanicalRun, request.mechanicalRun) &&
      sameArtifact(metadata.package, request.package) &&
      sameArtifact(metadata.source, pkg.source.artifact),
  );
  const assessment = AssessmentRecordSchema.parse(await read(request.assessment));
  const judgment = JudgmentRecordSchema.parse(await read(request.judgment));
  requireEvidence(
    sameArtifact(assessment.package, request.package) &&
      sameArtifact(assessment.body, request.body) &&
      sameArtifact(assessment.publication, request.publication) &&
      sameArtifact(assessment.source, pkg.source.artifact),
  );
  requireEvidence(
    !assessment.operationalFailure &&
      assessment.document &&
      ["findings", "no-faults"].includes(assessment.state),
  );
  const findings = classifyFindings(await content.read(artifactRef(assessment.document!)));
  requireEvidence(findings.state === assessment.state && findings.findings === assessment.findings);
  requireEvidence(
    judgment.state === "decided" &&
      judgment.decision === "revise" &&
      !judgment.operationalFailure &&
      judgment.document &&
      sameArtifact(judgment.assessment, request.assessment) &&
      sameArtifact(judgment.body, request.body) &&
      sameArtifact(judgment.publication, request.publication),
  );
  const guidance = parseJudgmentDocument(await content.read(artifactRef(judgment.document!)));
  requireEvidence(
    guidance &&
      (guidance.decision === "revise" ||
        (guidance.decision === "approve" &&
          judgment.gates.includes("deterministic-fault-blocks-approval") &&
          assessment.deterministicFindings.length > 0)),
  );
  const mechanical = MechanicalRecordSchema.parse(await read(request.mechanicalRun));
  requireEvidence(
    mechanical.outcome === "valid" &&
      sameArtifact(mechanical.package, request.package) &&
      mechanical.turns.length > 0,
  );
  const turn = mechanical.turns.at(-1)!;
  const attempt = WriterAttemptManifestSchema.parse(await read(turn.attempt));
  requireEvidence(
    attempt.raw &&
      !attempt.purpose &&
      !attempt.lateResponse &&
      ["revision", "correction"].includes(attempt.kind) &&
      attempt.number === turn.number &&
      sameArtifact(attempt.package, request.package) &&
      sameArtifact(attempt.source, pkg.source.artifact),
  );
  let accepted = false;
  for (const ref of metadata.writerAttempts ?? []) {
    const m = WriterAttemptManifestSchema.parse(await read(ref));
    if (
      m.attemptId === attempt.attemptId &&
      m.outcome === "accepted" &&
      !m.purpose &&
      !m.lateResponse &&
      m.raw &&
      sameArtifact(m.raw, attempt.raw!) &&
      sameArtifact(m.package, request.package) &&
      sameArtifact(m.source, pkg.source.artifact) &&
      sameArtifact(m.input, attempt.input) &&
      m.kind === attempt.kind &&
      m.number === turn.number &&
      m.revision === attempt.revision
    )
      accepted = true;
  }
  requireEvidence(accepted);
  const text = await content.read(artifactRef(turn.candidate ?? attempt.raw!));
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  }
  const candidate = ModelDraftSchema.parse(raw);
  requireEvidence(
    draftProblems(pkg, candidate).length === 0 && modelCitationProblems(candidate).length === 0,
  );
  requireEvidence(
    JSON.stringify(metadata.fields) ===
      JSON.stringify({
        title: candidate.title,
        subtitle: candidate.subtitle,
        excerpt: candidate.excerpt,
      }),
  );
  const original = z
    .object({
      source: z.object({ publicationId: z.string(), postId: z.string(), sourceUrl: z.url() }),
    })
    .parse(await read(intent.seed.parent.summary));
  requireEvidence(
    original.source.publicationId === pkg.post.publicationId &&
      original.source.postId === pkg.post.postId &&
      (!pkg.source.originalUrl || pkg.source.originalUrl === original.source.sourceUrl),
  );
  const markdown = renderPackageDraft(pkg, candidate, original.source.sourceUrl);
  requireEvidence(markdown === loaded.markdown);
  if (input.requireCurrent) {
    requireEvidence(content.lookup && content.lookupAt);
    await assertEditorialBaseCurrent(content as Pick<GitArtifactStore, "lookup" | "lookupAt">, {
      body: request.body,
      metadata: request.metadata,
    });
  }
  return {
    request,
    summary,
    payload: loaded.payload,
    markdown,
    post: pkg.post,
    assessment,
    judgment,
  };
}
