import { WriterRecoveryGuardError } from "../drafting/writer-attempts.js";
import {
  assertEditorialBaseCurrent,
  EditorialContinuationError,
} from "../drafting/editorial-continuation.js";
import { editorialLineageRefs } from "../content/editorial-lineage.js";
import { parseJudgmentDocument, emptyGuidance } from "../drafting/judgment-document.js";
import { reportCreditExhausted } from "../observability/provider-condition.js";
import type { ExtractionModelProvider } from "../analysis/extraction.js";
import type { GitArtifactStore, ArtifactRef } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import type { MechanicalPolicy } from "../drafting/mechanical-policy.js";
import {
  assessArticle,
  AssessmentRecordSchema,
  DEFAULT_ASSESSOR_PROMPT,
} from "../drafting/article-assessment.js";
import {
  judgeAssessment,
  JudgmentRecordSchema,
  DEFAULT_JUDGE_PROMPT,
} from "../drafting/editorial-judgment.js";
import { durableEditorialProvider } from "../drafting/editorial-provider.js";
import { loadArticleForReview } from "../drafting/package-verify.js";
import { draftFromPackage, DraftGuardStop, DraftCreditStop } from "../drafting/package-draft.js";
import { commitArticleRevision } from "../drafting/article-revisions.js";
import { isCanonicalArticlePath } from "../drafting/article-identity.js";
import { artifactReference, artifactRef, sameArtifact } from "../drafting/publication-payload.js";
import { recordApproval } from "../publishing/approved-article.js";
import { StageError } from "./article-run.js";
import type { EditorialStages, EditorialVersion } from "./editorial-contract.js";

export function editorialStages(deps: {
  content: GitArtifactStore;
  archive: GitArtifactStore;
  operations: OperationStore;
  writer: ExtractionModelProvider;
  assessor?: ExtractionModelProvider;
  judge?: ExtractionModelProvider;
  mechanicalPolicy?: MechanicalPolicy;
}): EditorialStages {
  const metadataFor = async (draft: ArtifactRef) => {
    if (isCanonicalArticlePath(draft.path)) {
      const saved = await deps.content.lookupAt(draft.commit, draft.path.replace(/\.md$/, ".json"));
      return saved && { ...saved.ref, commit: draft.commit };
    }
    return deps.content.lookup(draft.path.replace(/\.md$/, ".json"));
  };
  const bound = async (version: EditorialVersion, pkg: ArtifactRef) => {
    const loaded = await loadArticleForReview({ ...deps, metadata: version.metadata });
    if (
      loaded.status !== "loaded" ||
      !sameArtifact(artifactReference(loaded.draftRef), artifactReference(version.draft)) ||
      !sameArtifact(loaded.meta.package, artifactReference(pkg))
    )
      throw new StageError("editorial", "version-mismatch");
    return loaded;
  };
  return {
    async prepare(draft, pkg) {
      const metadata = await metadataFor(draft);
      if (!metadata) throw new StageError("editorial", "metadata-missing");
      const loaded = await bound({ draft, metadata }, pkg);
      if (isCanonicalArticlePath(metadata.path)) return { draft: loaded.draftRef, metadata };
      const committed = await commitArticleRevision({
        content: deps.content,
        article: loaded.pkg.post,
        generation: { draft, metadata },
        base: "current",
      });
      if (committed.status === "conflict") throw new StageError("editorial", "article-conflict");
      const version = {
        draft: { ...committed.body, commit: committed.metadata.commit },
        metadata: committed.metadata,
      };
      await bound(version, pkg);
      return version;
    },
    async assess(version, pkg, attemptId, recoveryId, lineage, beforeNewCall) {
      if (!deps.assessor) throw new StageError("editorial", "assessor-unconfigured");
      const loaded = await bound(version, pkg);
      const provider = durableEditorialProvider({
        ...deps,
        provider: deps.assessor,
        purpose: "assessor",
        package: pkg,
        source: loaded.pkg.source.artifact,
        context: [
          artifactReference(version.metadata),
          artifactReference(version.draft),
          artifactReference(loaded.publication.ref),
          ...editorialLineageRefs(lineage).map(artifactReference),
        ],
        promptVersion: DEFAULT_ASSESSOR_PROMPT.version,
        recoveryId,
        ...(beforeNewCall ? { beforeNewCall } : {}),
      });
      const out = await assessArticle({
        ...deps,
        metadata: version.metadata,
        assessor: provider,
        attemptId,
        retainedAttempts: provider.retainedAttempts,
        retainedAttemptReuses: provider.retainedAttemptReuses,
        retainOperationalFailure: true,
      });
      if (out.status !== "assessed") throw new StageError("editorial", out.reason);
      if (out.record.operationalFailure)
        reportCreditExhausted(loaded.pkg.post, "assess", loaded.pkg.source.sourceVersion);
      return {
        ref: out.ref,
        state: out.record.state,
        ...(out.record.operationalFailure
          ? { operationalFailure: out.record.operationalFailure }
          : {}),
      };
    },
    async judge(
      assessment,
      attemptId,
      recoveryId,
      history,
      lineage,
      expectedRecovery,
      beforeNewCall,
    ) {
      if (!deps.judge) throw new StageError("editorial", "judge-unconfigured");
      const record = AssessmentRecordSchema.parse(JSON.parse(await deps.content.read(assessment)));
      const provider = durableEditorialProvider({
        ...deps,
        provider: deps.judge,
        purpose: "judge",
        package: artifactRef(record.package),
        source: record.source,
        context: [
          record.body,
          record.publication,
          ...(history?.map((x) => x.judgment) ?? []),
          ...editorialLineageRefs(lineage).map(artifactReference),
        ],
        promptVersion: DEFAULT_JUDGE_PROMPT.version,
        recoveryId,
        ...(beforeNewCall ? { beforeNewCall } : {}),
        ...(expectedRecovery ? { expectedRecovery } : {}),
      });
      const out = await judgeAssessment({
        content: deps.content,
        assessment,
        ...(history?.length ? { history } : {}),
        judge: provider,
        attemptId,
        retainedAttempts: provider.retainedAttempts,
        retainedAttemptReuses: provider.retainedAttemptReuses,
        retainOperationalFailure: true,
      });
      if (out.status !== "judged") throw new StageError("editorial", out.reason);
      if (out.record.operationalFailure)
        reportCreditExhausted(
          { publicationId: record.body.path.split("/")[1], postId: record.body.path.split("/")[2] },
          "judge",
        );
      return {
        ref: out.ref,
        decision: out.record.decision,
        state: out.record.state,
        ...(out.record.operationalFailure
          ? { operationalFailure: out.record.operationalFailure }
          : {}),
      };
    },
    async revise(version, pkg, judgment, number, sourceUrl, recoveryId, lineage, beforeNewCall) {
      const loaded = await bound(version, pkg);
      const decision = JudgmentRecordSchema.parse(JSON.parse(await deps.content.read(judgment)));
      if (
        decision.state !== "decided" ||
        decision.decision !== "revise" ||
        !decision.document ||
        !sameArtifact(decision.body, artifactReference(version.draft)) ||
        !sameArtifact(decision.publication, artifactReference(loaded.publication.ref))
      )
        throw new StageError("editorial", "revision-guidance-mismatch");
      const assessment = AssessmentRecordSchema.parse(
        JSON.parse(await deps.content.read(artifactRef(decision.assessment))),
      );
      const guidance = parseJudgmentDocument(
        await deps.content.read(artifactRef(decision.document)),
      );
      if (!guidance) throw new StageError("editorial", "revision-guidance-incomplete");
      const feedback = [
        ...(!emptyGuidance(guidance.requiredCorrections)
          ? [{ passage: "Required editorial corrections", reason: guidance.requiredCorrections }]
          : []),
        ...assessment.deterministicFindings,
        ...(decision.gates.length
          ? [{ passage: "Deterministic editorial gates", reason: decision.gates.join("; ") }]
          : []),
      ];
      if (!feedback.length) throw new StageError("editorial", "revision-guidance-empty");
      let out;
      try {
        out = await draftFromPackage({
          ...deps,
          package: pkg,
          provider: deps.writer,
          sourceUrl,
          ...(recoveryId ? { writerRecoveryId: recoveryId } : {}),
          previousDraft: {
            ref: version.draft,
            markdown: loaded.markdown,
            metadataRef: version.metadata,
            ...(loaded.meta.fields ? { fields: loaded.meta.fields } : {}),
          },
          ...(lineage || beforeNewCall
            ? {
                ...(lineage ? { lineage } : {}),
                beforeNewGeneration: async () => {
                  await beforeNewCall?.();
                  await assertEditorialBaseCurrent(deps.content, {
                    body: artifactReference(version.draft),
                    metadata: artifactReference(version.metadata),
                  });
                },
              }
            : {}),
          revisionInputs: [
            version.metadata,
            judgment,
            artifactRef(decision.assessment),
            ...editorialLineageRefs(lineage),
          ],
          revision: {
            number,
            feedback,
            ...(!emptyGuidance(guidance.acceptedMinorObservations)
              ? {
                  observations: [
                    {
                      passage: "Accepted minor observations",
                      reason: guidance.acceptedMinorObservations,
                    },
                  ],
                }
              : {}),
          },
        });
      } catch (error) {
        const cause = error instanceof DraftGuardStop ? error.failure : error;
        if ((lineage || beforeNewCall) && cause instanceof WriterRecoveryGuardError)
          return {
            failure: `${lineage ? "recovery" : "live-policy"}-${cause.code}`,
            ...(error instanceof DraftGuardStop ? error.retention : {}),
          };
        if ((lineage || beforeNewCall) && cause instanceof EditorialContinuationError)
          return {
            failure: cause.code,
            ...(error instanceof DraftGuardStop ? error.retention : {}),
          };
        if (lineage && error instanceof DraftCreditStop)
          return {
            failure: "credit-exhausted",
            mechanicalRun: error.mechanicalRun,
            retainedAttempts: error.writerAttempts,
            diagnostics: error.diagnostics,
          };
        throw cause;
      }
      if (out.status !== "drafted")
        return {
          failure: out.status === "failed" ? out.reason : out.status,
          ...("writerAttempts" in out && out.writerAttempts
            ? { retainedAttempts: out.writerAttempts }
            : {}),
          ...("mechanicalRun" in out && out.mechanicalRun
            ? { mechanicalRun: out.mechanicalRun }
            : {}),
          ...("diagnostics" in out && out.diagnostics ? { diagnostics: out.diagnostics } : {}),
        };
      const committed = await commitArticleRevision({
        content: deps.content,
        article: loaded.pkg.post,
        generation: { draft: out.draft, metadata: out.metadata },
        base: { body: version.draft.sha256, metadata: version.metadata.sha256 },
      });
      if (committed.status === "conflict") return { failure: "article-conflict" };
      const next = {
        draft: { ...committed.body, commit: committed.metadata.commit },
        metadata: committed.metadata,
      };
      await bound(next, pkg);
      return {
        version: next,
        mechanicalRun: out.mechanicalRun,
        retainedAttempts: out.writerAttempts,
      };
    },
    approve: (report) =>
      recordApproval({
        content: deps.content,
        operations: deps.operations,
        report,
        kind: "editorial-judgment",
      }),
  };
}
