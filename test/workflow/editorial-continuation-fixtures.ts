import { createHash } from "node:crypto";
import { expect } from "vite-plus/test";
import type { GitArtifactStore } from "../../src/controllers/artifact-store.js";
import type { OperationStore } from "../../src/controllers/operation-store.js";
import { artifactRef, artifactReference } from "../../src/drafting/publication-payload.js";
import {
  readEditorialContinuation,
  type EditorialContinuationInput,
} from "../../src/drafting/editorial-continuation.js";
import { editorialStages } from "../../src/workflow/editorial-stages.js";
import { editorialAttemptIdentity } from "../../src/workflow/editorial-attempt-identity.js";
import { recordArticleAttempt } from "../../src/workflow/article-attempt.js";
import { ArticleRunInputSchema } from "../../src/workflow/article-run.js";
import { PackageVerificationReportSchema } from "../../src/drafting/package-verify.js";
import { draftFromPackage } from "../../src/drafting/package-draft.js";
import { saveSourceContext, sourceContextFor } from "../../src/content/source-context.js";
import { parseSourceMetadata, postAttribution } from "../../src/content/source-metadata.js";
import {
  approvedReport,
  archive as fixtureArchive,
  WRITER,
} from "../publishing/approval-fixtures.js";
export const REVISE =
  "## Reasons\nA material scope correction remains.\n## Required corrections\nNarrow the claim to its source.\n## Accepted minor observations\nKeep the supported tone.\nDECISION: REVISE";
export const APPROVE =
  "## Reasons\nThe exact article is supported.\n## Required corrections\nNone.\n## Accepted minor observations\nNone.\nDECISION: APPROVE";
export async function continuationParentFixture(
  content: GitArtifactStore,
  operations: OperationStore,
  revisionCount = 0,
  options: { modern?: boolean } = {},
) {
  const modern = options.modern ?? false,
    historicalInputOrder = false,
    metadataOnlyBase = false;
  const report = PackageVerificationReportSchema.parse(
    JSON.parse(await content.read(await approvedReport(content))),
  );
  if (report.schemaVersion !== 2) throw new Error("fixture report");
  let pkgRef = artifactRef(report.package),
    draft = artifactRef(report.draft);
  const pkg = JSON.parse(await content.read(pkgRef));
  const sourceMetadata = modern
    ? parseSourceMetadata([
        {
          sourceId: "pub",
          sourceType: "substack",
          displayName: "Synthetic Publication",
          defaultAuthor: "Configured Person",
        },
      ])
    : undefined;
  const capture = JSON.parse(await fixtureArchive.read(artifactRef(pkg.source.artifact)));
  const archive = {
    read: async (r: Parameters<GitArtifactStore["read"]>[0]) => {
      expect(artifactReference(r)).toEqual(pkg.source.artifact);
      return JSON.stringify(capture);
    },
    lookup: async (path: string) =>
      path === pkg.source.artifact.path ? artifactRef(pkg.source.artifact) : undefined,
  };
  if (modern) {
    const context = await saveSourceContext(
      content,
      sourceContextFor(
        capture,
        artifactRef(pkg.source.artifact),
        postAttribution(sourceMetadata, capture.item),
      ),
    );
    pkg.source.context = artifactReference(context);
    pkgRef = await content.write(
      "writer-packages/synthetic-modern-context.json",
      JSON.stringify(pkg),
    );
    const generated = await draftFromPackage({
      operations,
      content,
      archive,
      package: pkgRef,
      sourceUrl: capture.item.url,
      provider: { modelVersion: "fake/fixture-writer", complete: async () => WRITER },
    });
    if (generated.status !== "drafted") throw new Error(generated.status);
    draft = generated.draft;
  }
  const stages = editorialStages({
    content,
    operations,
    archive,
    assessor: {
      modelVersion: "fake/assessor",
      complete: async () => "No faults found.\nEND OF ASSESSMENT",
    },
    judge: { modelVersion: "fake/judge", complete: async () => REVISE },
    writer: {
      modelVersion: "fake/writer-unused",
      complete: async () => {
        throw new Error("reader has no writer capability");
      },
    },
  });
  let version = await stages.prepare(draft, pkgRef);
  if (metadataOnlyBase) {
    const meta = JSON.parse(await content.read(version.metadata));
    const next = await content.revise(
      version.metadata.path,
      JSON.stringify({
        ...meta,
        fields: { ...meta.fields, title: "A valid metadata-only version" },
      }),
      version.metadata.sha256,
    );
    version = { draft: { ...version.draft, commit: next.commit }, metadata: next };
  }
  const input = ArticleRunInputSchema.parse({
    publicationId: "pub",
    postId: "p1",
    sourceVersion: pkg.source.sourceVersion,
    sourceUrl: capture.item.url,
    researchDeadlineMs: 30_000,
    editorial: { version: "assess-judge-v1", maxRevisions: revisionCount, deadlineMs: 30_000 },
    operatorRequestId: "synthetic-parent",
  });
  const savedInput = historicalInputOrder
    ? (Object.fromEntries(Object.entries(input).reverse()) as typeof input)
    : input;
  const identity = historicalInputOrder
    ? operations.recordArticleAttempt({
        publicationId: input.publicationId,
        postId: input.postId,
        sourceVersion: input.sourceVersion,
        requestId: input.operatorRequestId!,
        inputHash: createHash("sha256").update(JSON.stringify(savedInput)).digest("hex"),
      })
    : recordArticleAttempt(operations, input, input.operatorRequestId!).identity;
  const attempt = editorialAttemptIdentity(input).attemptId;
  const initial = version;
  const assessments = [],
    judgments = [],
    revisions: (typeof version)[] = [];
  const history: EditorialContinuationInput["history"] = [];
  for (let round = 0; round <= revisionCount; round++) {
    const assessment = await stages.assess(version, pkgRef, `${attempt}:assessment:${round}`);
    const judgment = await stages.judge(assessment.ref, `${attempt}:judgment:${round}`, undefined, [
      ...history,
    ]);
    assessments.push(assessment.ref);
    judgments.push(judgment.ref);
    history.push({
      judgment: artifactReference(judgment.ref),
      assessment: artifactReference(assessment.ref),
      body: artifactReference(version.draft),
      metadata: artifactReference(version.metadata),
    });
    if (round < revisionCount) {
      const meta = JSON.parse(await content.read(version.metadata));
      const next = await content.revise(
        version.metadata.path,
        JSON.stringify({
          ...meta,
          fields: { ...meta.fields, title: `Synthetic linked version ${round + 1}` },
        }),
        version.metadata.sha256,
      );
      version = { draft: { ...version.draft, commit: next.commit }, metadata: next };
      revisions.push(version);
    }
  }
  const assessment = { ref: assessments.at(-1)! },
    judgment = { ref: judgments.at(-1)! };
  const decision = JSON.parse(await content.read(judgment.ref));
  let summary = {
    version: "assess-judge-v1",
    initial,
    assessments,
    judgments,
    revisions,
    mechanicalRuns: [],
    diagnostics: [],
    terminal: "unresolved",
    input: savedInput,
  };
  const saveSummary = async () => {
    const key = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
    return content.write(`editorial-loops/pub/p1/${key}.json`, JSON.stringify(summary));
  };
  const summaryRef = await saveSummary();
  const request: EditorialContinuationInput = {
    version: "editorial-continuation-v1",
    parent: { workflowKey: identity.workflowKey, summary: artifactReference(summaryRef) },
    package: artifactReference(pkgRef),
    body: artifactReference(version.draft),
    metadata: artifactReference(version.metadata),
    publication: decision.publication,
    assessment: artifactReference(assessment.ref),
    judgment: artifactReference(judgment.ref),
    history,
  };
  const read = (overrides: Partial<Parameters<typeof readEditorialContinuation>[0]> = {}) =>
    readEditorialContinuation({
      request,
      content,
      archive,
      operations,
      sourceMetadata,
      ...overrides,
    });
  const changeSummary = async (edit: (s: any) => void) => {
    summary = structuredClone(summary);
    edit(summary);
    request.parent.summary = artifactReference(await saveSummary());
  };
  const changeJudgment = async (edit: (j: any) => void) => {
    const next = structuredClone(decision);
    edit(next);
    const ref = await content.write(
      `judgments/pub/p1/synthetic-${createHash("sha256").update(JSON.stringify(next)).digest("hex")}.json`,
      JSON.stringify(next),
    );
    request.judgment = artifactReference(ref);
    request.history[0]!.judgment = artifactReference(ref);
    await changeSummary((s) => {
      s.judgments[0] = ref;
    });
  };
  return {
    read,
    request,
    version,
    archive,
    pkg,
    pkgRef,
    sourceMetadata,
    summary,
    changeSummary,
    changeJudgment,
  };
}
