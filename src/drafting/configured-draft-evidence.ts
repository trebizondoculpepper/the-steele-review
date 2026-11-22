import { SourceContextSchema } from "../content/source-context.js";
import { articleAttemptHash } from "../workflow/article-attempt.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  ConfiguredDraftCheckpointSchema,
  ConfiguredDraftRequestSchema,
  type ConfiguredDraftRequest,
} from "../content/configured-draft-authorization.js";
import { ArticleRunInputSchema } from "../workflow/article-run.js";
import { WriterPackageSchema } from "./writer-package.js";
import { PackageDraftMetadataSchema } from "./package-draft.js";
import { AssessmentRecordSchema, classifyFindings } from "./article-assessment.js";
import { JudgmentRecordSchema } from "./editorial-judgment.js";
import { parseJudgmentDocument } from "./judgment-document.js";
import {
  artifactRef,
  artifactReference,
  sameArtifact,
  readPublicationPayload,
} from "./publication-payload.js";
import { readDraftMechanicalEvidence } from "./draft-mechanical-evidence.js";
import { assertEditorialBaseCurrent } from "./editorial-continuation.js";

export class ConfiguredDraftEvidenceError extends Error {
  constructor() {
    super("configured draft evidence mismatch");
  }
}
const requireEvidence = (condition: unknown) => {
  if (!condition) throw new ConfiguredDraftEvidenceError();
};

/** Read only; state authority and provenance are required independently of a model's verdict. */
export async function readConfiguredDraftEvidence(input: {
  request: ConfiguredDraftRequest;
  content: Pick<GitArtifactStore, "read"> & Partial<Pick<GitArtifactStore, "lookup" | "lookupAt">>;
  operations: Pick<OperationStore, "articleAttempt">;
  requireCurrent?: boolean;
}) {
  const request = ConfiguredDraftRequestSchema.parse(input.request);
  const read = async (ref: Parameters<typeof artifactRef>[0]) =>
    JSON.parse(await input.content.read(artifactRef(ref)));
  const checkpoint = ConfiguredDraftCheckpointSchema.parse(await read(request.checkpoint));
  const run = ArticleRunInputSchema.parse(checkpoint.input);
  requireEvidence(
    run.editorialExecution === "live-policy-v1" && run.operatorRequestId && !run.editorial,
  );
  requireEvidence(articleAttemptHash(run) === checkpoint.inputHash);
  const recorded = input.operations.articleAttempt(
    run.publicationId,
    run.postId,
    run.operatorRequestId!,
  );
  requireEvidence(
    recorded &&
      recorded.workflowKey === checkpoint.workflowKey &&
      recorded.inputHash === checkpoint.inputHash &&
      recorded.sourceVersion === run.sourceVersion,
  );
  for (const key of [
    "body",
    "metadata",
    "publication",
    "package",
    "assessment",
    "judgment",
  ] as const)
    requireEvidence(sameArtifact(checkpoint[key], request[key]));
  requireEvidence(
    sameArtifact(checkpoint.assessments.at(-1)!, request.assessment) &&
      sameArtifact(checkpoint.judgments.at(-1)!, request.judgment),
  );
  requireEvidence(
    checkpoint.assessments.length === checkpoint.judgments.length &&
      checkpoint.assessments.length === checkpoint.revisions.length + 1 &&
      checkpoint.revisions.length === checkpoint.mechanicalRuns.length,
  );
  const policy = checkpoint.appliedPolicy.policy;
  requireEvidence(policy.onExhausted === "create-unpublished-draft");
  const pkg = WriterPackageSchema.parse(await read(request.package));
  requireEvidence(
    pkg.post.publicationId === run.publicationId &&
      pkg.post.postId === run.postId &&
      pkg.source.sourceVersion === run.sourceVersion &&
      pkg.source.context &&
      sameArtifact(pkg.source.context, checkpoint.sourceContext) &&
      (!pkg.source.originalUrl || pkg.source.originalUrl === run.sourceUrl),
  );
  const sourceContext = SourceContextSchema.parse(await read(checkpoint.sourceContext));
  requireEvidence(
    sameArtifact(sourceContext.source.archive, pkg.source.artifact) &&
      sourceContext.source.sourceVersion === run.sourceVersion &&
      sourceContext.source.id === run.publicationId &&
      sourceContext.source.postId === run.postId &&
      sourceContext.source.url === run.sourceUrl,
  );
  if (run.source)
    requireEvidence(sameArtifact(artifactReference(run.source.artifact), pkg.source.artifact));
  const loaded = await readPublicationPayload(input.content, request.publication);
  requireEvidence(
    loaded.payload.mode === "structured" &&
      sameArtifact(loaded.payload.body, request.body) &&
      sameArtifact(loaded.payload.metadata, request.metadata),
  );
  const versions = [checkpoint.initial, ...checkpoint.revisions];
  for (let index = 0; index < versions.length; index++) {
    const version = versions[index]!;
    const priorAssessment = AssessmentRecordSchema.parse(
      await read(checkpoint.assessments[index]!),
    );
    const priorJudgment = JudgmentRecordSchema.parse(await read(checkpoint.judgments[index]!));
    requireEvidence(
      !priorAssessment.operationalFailure &&
        priorAssessment.document &&
        ["findings", "no-faults"].includes(priorAssessment.state) &&
        sameArtifact(priorAssessment.package, request.package) &&
        sameArtifact(priorAssessment.source, pkg.source.artifact) &&
        sameArtifact(priorAssessment.body, version.body) &&
        sameArtifact(priorJudgment.body, version.body) &&
        sameArtifact(priorJudgment.assessment, checkpoint.assessments[index]!) &&
        sameArtifact(priorAssessment.publication, priorJudgment.publication) &&
        !priorJudgment.operationalFailure &&
        priorJudgment.state === "decided" &&
        priorJudgment.document &&
        (index === versions.length - 1 || priorJudgment.decision === "revise"),
    );
    const priorPublication = await readPublicationPayload(
      input.content,
      priorAssessment.publication,
    );
    requireEvidence(
      sameArtifact(priorPublication.payload.body, version.body) &&
        sameArtifact(priorPublication.payload.metadata, version.metadata),
    );
    const versionMetadata = PackageDraftMetadataSchema.parse(await read(version.metadata));
    requireEvidence(
      versionMetadata.mechanicalRun &&
        sameArtifact(versionMetadata.package, request.package) &&
        sameArtifact(versionMetadata.source, pkg.source.artifact) &&
        versionMetadata.sourceContext &&
        sameArtifact(versionMetadata.sourceContext, checkpoint.sourceContext),
    );
    if (index > 0)
      requireEvidence(
        sameArtifact(versionMetadata.mechanicalRun!, checkpoint.mechanicalRuns[index - 1]!),
      );
    const previous = index > 0 ? versions[index - 1] : undefined;
    await readDraftMechanicalEvidence({
      content: input.content,
      request: { package: request.package, mechanicalRun: versionMetadata.mechanicalRun! },
      pkg,
      metadata: versionMetadata,
      sourceUrl: run.sourceUrl,
      markdown: priorPublication.markdown,
      allowedKinds: index > 0 ? ["revision", "correction"] : ["initial", "correction"],
      ...(index > 0 ? { expectedRevision: index } : {}),
      requiredContext: [
        checkpoint.sourceContext,
        pkg.coverage,
        pkg.themeResult,
        pkg.claimResult,
        ...(previous
          ? [
              previous.body,
              previous.metadata,
              checkpoint.judgments[index - 1]!,
              checkpoint.assessments[index - 1]!,
            ]
          : []),
      ],
    });
    const previousFindings = classifyFindings(
      await input.content.read(artifactRef(priorAssessment.document!)),
    );
    requireEvidence(
      previousFindings.state === priorAssessment.state &&
        previousFindings.findings === priorAssessment.findings,
    );
    requireEvidence(
      priorJudgment.gates.every((gate) => gate === "deterministic-fault-blocks-approval") &&
        (!priorJudgment.gates.length ||
          (priorJudgment.decision === "revise" &&
            priorAssessment.deterministicFindings.length > 0)),
    );
    const previousGuidance = parseJudgmentDocument(
      await input.content.read(artifactRef(priorJudgment.document!)),
    );
    requireEvidence(
      previousGuidance &&
        (previousGuidance.decision === priorJudgment.decision ||
          (previousGuidance.decision === "approve" &&
            priorJudgment.decision === "revise" &&
            priorJudgment.gates.includes("deterministic-fault-blocks-approval") &&
            priorAssessment.deterministicFindings.length > 0)),
    );
  }
  const metadata = PackageDraftMetadataSchema.parse(await read(request.metadata));
  requireEvidence(
    metadata.mechanicalRun &&
      sameArtifact(metadata.mechanicalRun, checkpoint.mechanicalRun) &&
      sameArtifact(metadata.package, request.package) &&
      sameArtifact(metadata.source, pkg.source.artifact) &&
      metadata.sourceContext &&
      sameArtifact(metadata.sourceContext, checkpoint.sourceContext),
  );
  const assessment = AssessmentRecordSchema.parse(await read(request.assessment));
  const judgment = JudgmentRecordSchema.parse(await read(request.judgment));
  requireEvidence(
    !assessment.operationalFailure &&
      assessment.document &&
      ["findings", "no-faults"].includes(assessment.state) &&
      sameArtifact(assessment.package, request.package) &&
      sameArtifact(assessment.source, pkg.source.artifact) &&
      sameArtifact(assessment.body, request.body) &&
      sameArtifact(assessment.publication, request.publication),
  );
  const findings = classifyFindings(await input.content.read(artifactRef(assessment.document!)));
  requireEvidence(findings.state === assessment.state && findings.findings === assessment.findings);
  requireEvidence(
    !judgment.operationalFailure &&
      judgment.state === "decided" &&
      judgment.document &&
      ["approve", "revise"].includes(judgment.decision) &&
      sameArtifact(judgment.assessment, request.assessment) &&
      sameArtifact(judgment.body, request.body) &&
      sameArtifact(judgment.publication, request.publication),
  );
  const guidance = parseJudgmentDocument(await input.content.read(artifactRef(judgment.document!)));
  requireEvidence(
    guidance &&
      (guidance.decision === judgment.decision ||
        (guidance.decision === "approve" &&
          judgment.decision === "revise" &&
          judgment.gates.includes("deterministic-fault-blocks-approval") &&
          assessment.deterministicFindings.length > 0)),
  );
  requireEvidence(
    judgment.decision === "approve" || checkpoint.revisions.length >= policy.maxRevisions,
  );
  if (checkpoint.revisions.length) {
    const last = checkpoint.revisions.at(-1)!;
    requireEvidence(
      sameArtifact(last.body, request.body) &&
        sameArtifact(last.metadata, request.metadata) &&
        sameArtifact(checkpoint.mechanicalRuns.at(-1)!, checkpoint.mechanicalRun),
    );
  }
  if (input.requireCurrent) {
    requireEvidence(input.content.lookup && input.content.lookupAt);
    await assertEditorialBaseCurrent(
      input.content as Pick<GitArtifactStore, "lookup" | "lookupAt">,
      { body: request.body, metadata: request.metadata },
    );
  }
  return {
    request,
    checkpoint,
    post: pkg.post,
    markdown: loaded.markdown,
    payload: loaded.payload,
    assessment,
    judgment,
  };
}
