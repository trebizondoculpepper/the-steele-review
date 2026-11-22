import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import { JudgmentHistorySchema } from "../content/judgment-history.js";
import { postAttribution, type ParsedSourceMetadata } from "../content/source-metadata.js";
import { sourceContextFor, SourceContextError } from "../content/source-context.js";
import { CollectionRecordSchema } from "../collection/collection-store.js";
import { ArtifactStoreError, type GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { ArticleRunInputSchema } from "../workflow/article-run.js";
import { editorialAttemptIdentity } from "../workflow/editorial-attempt-identity.js";
import { articlePaths } from "./article-identity.js";
import { AssessmentRecordSchema, classifyFindings } from "./article-assessment.js";
import { JudgmentRecordSchema } from "./editorial-judgment.js";
import { parseJudgmentDocument } from "./judgment-document.js";
import { PackageDraftMetadataSchema } from "./package-draft.js";
import { WriterPackageSchema } from "./writer-package.js";
import { loadPinnedContext } from "./pinned-context.js";
import {
  artifactRef,
  artifactReference,
  readPublicationPayload,
  sameArtifact,
  PublicationPayloadError,
} from "./publication-payload.js";

const Ref = ArtifactReferenceSchema;
const StoredRef = Ref.omit({ hash: true })
  .extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const Version = z.object({ draft: StoredRef, metadata: StoredRef }).strict();
/** Exact operator-selected inputs. This is not an approval or permission to call a model. */
export const EditorialContinuationInputSchema = z
  .object({
    version: z.literal("editorial-continuation-v1"),
    parent: z.object({ workflowKey: z.string().min(1).max(1000), summary: Ref }).strict(),
    package: Ref,
    body: Ref,
    metadata: Ref,
    publication: Ref,
    assessment: Ref,
    judgment: Ref,
    history: JudgmentHistorySchema,
  })
  .strict();
export type EditorialContinuationInput = z.infer<typeof EditorialContinuationInputSchema>;
/** Existing saved ArticleRun summaries: no migration or mutation of the terminal parent. */
export const EditorialParentSummarySchema = z
  .object({
    version: z.literal("assess-judge-v1"),
    initial: Version,
    assessments: z.array(StoredRef).min(1).max(6),
    judgments: z.array(StoredRef).min(1).max(6),
    revisions: z.array(Version).max(5),
    mechanicalRuns: z.array(StoredRef).max(5),
    diagnostics: z.array(StoredRef).max(100),
    terminal: z.enum(["approved", "unresolved", "operational-stop", "deadline"]),
    input: ArticleRunInputSchema,
  })
  .strict();
export class EditorialContinuationError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "parent-mismatch"
      | "parent-not-resumable"
      | "version-mismatch"
      | "source-mismatch"
      | "judgment-invalid"
      | "history-mismatch"
      | "stale-base"
      | "unreadable",
  ) {
    super(`editorial continuation: ${code}`);
    this.name = "EditorialContinuationError";
  }
}
const requireMatch = (ok: unknown, code: EditorialContinuationError["code"]) => {
  if (!ok) throw new EditorialContinuationError(code);
};
const equal = (a: ArtifactReference | undefined, b: ArtifactReference | undefined) =>
  a && b ? sameArtifact(a, b) : a === b;

/** Current canonical snapshot proof, reusable immediately before a new paid edit. */
export async function assertEditorialBaseCurrent(
  content: Pick<GitArtifactStore, "lookup" | "lookupAt">,
  version: { body: ArtifactReference; metadata: ArtifactReference },
) {
  const [currentBody, currentMetadata, bodyAtMetadata, bodyAtSelected] = await Promise.all([
    content.lookup(version.body.path),
    content.lookup(version.metadata.path),
    content.lookupAt(version.metadata.commit, version.body.path),
    content.lookupAt(version.body.commit, version.body.path),
  ]);
  requireMatch(
    currentBody &&
      currentMetadata &&
      bodyAtMetadata &&
      bodyAtSelected &&
      equal(artifactReference(currentBody), artifactReference(bodyAtMetadata.ref)) &&
      equal(artifactReference(currentBody), artifactReference(bodyAtSelected.ref)) &&
      equal(
        artifactReference({ ...bodyAtSelected.ref, commit: version.body.commit }),
        version.body,
      ) &&
      equal(artifactReference(currentMetadata), version.metadata),
    "stale-base",
  );
}

/**
 * Read-only exact-chain validation, before a paid capability is supplied.
 * The intent row does not prove workflow completion. The continuation entrypoint
 * must independently require typed Restate completion returning this exact
 * summary, plus no conflicting active writer, before any paid revision.
 * A later workflow must recheck the canonical base before its first revision;
 * revision commits retain their existing compare-and-swap conflict protection.
 */
async function readSeed(
  input: {
    request: unknown;
    content: Pick<GitArtifactStore, "read" | "lookup" | "lookupAt">;
    archive: Pick<GitArtifactStore, "read" | "lookup">;
    operations: Pick<OperationStore, "articleAttempt">;
    sourceMetadata?: ParsedSourceMetadata;
  },
  currentBase: boolean,
) {
  const parsed = EditorialContinuationInputSchema.safeParse(input.request);
  if (!parsed.success) throw new EditorialContinuationError("invalid-input");
  const request = parsed.data;
  try {
    const read = async (r: ArtifactReference) =>
      JSON.parse(await input.content.read(artifactRef(r)));
    const rawSummary = await read(request.parent.summary);
    const summary = EditorialParentSummarySchema.parse(rawSummary);
    requireMatch(summary.terminal === "unresolved", "parent-not-resumable");
    const parent = summary.input;
    const summaryKey = createHash("sha256").update(JSON.stringify(rawSummary)).digest("hex");
    requireMatch(
      request.parent.summary.path ===
        `editorial-loops/${parent.publicationId}/${parent.postId}/${summaryKey}.json`,
      "parent-mismatch",
    );
    requireMatch(
      parent.editorial && summary.revisions.length === parent.editorial.maxRevisions,
      "parent-not-resumable",
    );
    requireMatch(parent.editorial && parent.operatorRequestId, "parent-mismatch");
    const recorded = input.operations.articleAttempt(
      parent.publicationId,
      parent.postId,
      parent.operatorRequestId!,
    );
    requireMatch(
      recorded &&
        recorded.workflowKey === request.parent.workflowKey &&
        recorded.sourceVersion === parent.sourceVersion &&
        recorded.inputHash ===
          createHash("sha256")
            .update(JSON.stringify((rawSummary as { input: unknown }).input))
            .digest("hex"),
      "parent-mismatch",
    );
    const versions = [summary.initial, ...summary.revisions];
    requireMatch(
      summary.assessments.length === versions.length &&
        summary.judgments.length === versions.length,
      "parent-mismatch",
    );
    const final = versions.at(-1)!;
    requireMatch(
      equal(request.body, artifactReference(final.draft)) &&
        equal(request.metadata, artifactReference(final.metadata)) &&
        equal(request.assessment, artifactReference(summary.assessments.at(-1)!)) &&
        equal(request.judgment, artifactReference(summary.judgments.at(-1)!)),
      "version-mismatch",
    );
    const pkg = WriterPackageSchema.parse(await read(request.package));
    requireMatch(
      pkg.status === "ready" &&
        pkg.post.publicationId === parent.publicationId &&
        pkg.post.postId === parent.postId &&
        pkg.source.sourceVersion === parent.sourceVersion,
      "source-mismatch",
    );
    requireMatch(
      !parent.source || equal(pkg.source.artifact, artifactReference(parent.source.artifact)),
      "source-mismatch",
    );
    const paths = articlePaths(pkg.post);
    requireMatch(
      request.body.path === paths.body && request.metadata.path === paths.metadata,
      "version-mismatch",
    );
    const currentSource = await input.archive.lookup(pkg.source.artifact.path);
    requireMatch(
      currentSource && equal(artifactReference(currentSource), pkg.source.artifact),
      "source-mismatch",
    );
    const capture = CollectionRecordSchema.parse(
      JSON.parse(await input.archive.read(artifactRef(pkg.source.artifact))),
    );
    requireMatch(
      capture.item.publicationId === parent.publicationId &&
        capture.item.postId === parent.postId &&
        capture.item.url === parent.sourceUrl &&
        (!pkg.source.originalUrl || pkg.source.originalUrl === parent.sourceUrl),
      "source-mismatch",
    );
    const currentContext = sourceContextFor(
      capture,
      artifactRef(pkg.source.artifact),
      postAttribution(input.sourceMetadata, capture.item),
      parent.source ? { namespace: parent.source.namespace } : undefined,
    );
    // loadPinnedContext deliberately returns domain outcomes. Preserve operational
    // read failures rather than turning a temporary Git error into invalid input.
    let readFailure: unknown;
    const tracked = (store: Pick<GitArtifactStore, "read">) => ({
      read: async (r: Parameters<GitArtifactStore["read"]>[0]) => {
        try {
          return await store.read(r);
        } catch (error) {
          readFailure = error;
          throw error;
        }
      },
    });
    const context = await loadPinnedContext({
      content: tracked(input.content),
      archive: tracked(input.archive),
      brief: {
        source: {
          ...pkg.post,
          url: parent.sourceUrl,
          sourceVersion: pkg.source.sourceVersion,
          artifact: pkg.source.artifact,
          ingestionReason: "backfill",
        },
      },
      themes: artifactRef(pkg.themeResult),
      ...(pkg.source.context ? { sourceContext: artifactRef(pkg.source.context) } : {}),
    });
    if (readFailure) throw readFailure;
    requireMatch(context.kind === "loaded", "source-mismatch");
    if (context.kind !== "loaded") throw new EditorialContinuationError("source-mismatch");
    requireMatch(
      JSON.stringify(context.context.source.provenance) === JSON.stringify(currentContext),
      "source-mismatch",
    );
    const expectedHistory = versions.map((version, i) => ({
      judgment: artifactReference(summary.judgments[i]!),
      assessment: artifactReference(summary.assessments[i]!),
      body: artifactReference(version.draft),
      metadata: artifactReference(version.metadata),
    }));
    requireMatch(
      JSON.stringify(request.history) === JSON.stringify(expectedHistory.slice(-5)),
      "history-mismatch",
    );
    const attempt = editorialAttemptIdentity(parent).attemptId;
    for (let i = 0; i < versions.length; i++) {
      const h = expectedHistory[i]!,
        assessment = AssessmentRecordSchema.parse(await read(h.assessment)),
        judgment = JudgmentRecordSchema.parse(await read(h.judgment));
      requireMatch(
        (assessment.state === "findings" || assessment.state === "no-faults") &&
          assessment.document &&
          !assessment.operationalFailure &&
          judgment.state === "decided" &&
          judgment.decision === "revise" &&
          judgment.document &&
          judgment.judge &&
          !judgment.operationalFailure,
        "judgment-invalid",
      );
      requireMatch(
        assessment.attemptId === `${attempt}:assessment:${i}` &&
          judgment.attemptId === `${attempt}:judgment:${i}`,
        "parent-mismatch",
      );
      const assessed = classifyFindings(
        await input.content.read(artifactRef(assessment.document!)),
      );
      requireMatch(
        assessed.state === assessment.state && assessed.findings === assessment.findings,
        "judgment-invalid",
      );
      const guidance = parseJudgmentDocument(
        await input.content.read(artifactRef(judgment.document!)),
      );
      requireMatch(
        guidance &&
          (guidance.decision === "revise" ||
            judgment.gates.length > 0 ||
            assessment.deterministicFindings.length > 0),
        "judgment-invalid",
      );
      requireMatch(
        equal(judgment.assessment, h.assessment) &&
          equal(judgment.body, h.body) &&
          equal(assessment.body, h.body) &&
          equal(judgment.publication, assessment.publication) &&
          equal(assessment.package, request.package) &&
          equal(assessment.source, pkg.source.artifact) &&
          equal(assessment.sourceContext, pkg.source.context) &&
          assessment.contextVersion === context.context.contextRef,
        "version-mismatch",
      );
      if (judgment.history)
        requireMatch(
          JSON.stringify(judgment.history) ===
            JSON.stringify(expectedHistory.slice(0, i).slice(-5)),
          "history-mismatch",
        );
      const { payload } = await readPublicationPayload(input.content, judgment.publication);
      requireMatch(
        equal(payload.body, h.body) && equal(payload.metadata, h.metadata),
        "version-mismatch",
      );
      const metadata = PackageDraftMetadataSchema.parse(await read(h.metadata));
      requireMatch(
        equal(metadata.package, request.package) &&
          (!metadata.contextVersion || metadata.contextVersion === context.context.contextRef),
        "version-mismatch",
      );
      if (i === versions.length - 1)
        requireMatch(equal(judgment.publication, request.publication), "version-mismatch");
    }
    if (currentBase)
      await assertEditorialBaseCurrent(input.content, {
        body: request.body,
        metadata: request.metadata,
      });
    return {
      version: request.version,
      request,
      article: {
        ...pkg.post,
        sourceVersion: pkg.source.sourceVersion,
        sourceUrl: parent.sourceUrl,
      },
      parentCompletionRequired: {
        workflowKey: request.parent.workflowKey,
        summary: request.parent.summary,
      },
      parentPolicy: parent.editorial!,
      priorCounts: {
        assessments: summary.assessments.length,
        judgments: summary.judgments.length,
        revisions: summary.revisions.length,
      },
      initial: { draft: artifactRef(request.body), metadata: artifactRef(request.metadata) },
      package: artifactRef(request.package),
      judgment: artifactRef(request.judgment),
      history: request.history,
    };
  } catch (error) {
    if (error instanceof EditorialContinuationError) throw error;
    if (error instanceof ArtifactStoreError) {
      if (["not-found", "hash-mismatch", "invalid-path"].includes(error.code))
        throw new EditorialContinuationError("unreadable");
      throw error;
    }
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof PublicationPayloadError ||
      error instanceof SourceContextError
    )
      throw new EditorialContinuationError("version-mismatch");
    throw error;
  }
}
/** Execution seed: validates the archived chain and requires that selected base is current. */
export const readEditorialContinuation = (input: Parameters<typeof readSeed>[0]) =>
  readSeed(input, true);
/** Archived audit only. Never authorizes a new edit; a child must separately prove its own current base. */
export const readEditorialContinuationHistory = (input: Parameters<typeof readSeed>[0]) =>
  readSeed(input, false);
export type ValidatedEditorialContinuation = Awaited<ReturnType<typeof readEditorialContinuation>>;
