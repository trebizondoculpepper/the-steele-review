import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import {
  ModelDraftSchema,
  draftProblems,
  modelCitationProblems,
  renderPackageDraft,
  PackageDraftMetadataSchema,
  markdownEvidenceView,
  markdownCitationIssues,
  renderMarkdownDraft,
} from "./package-draft.js";
import {
  MARKDOWN_ARTICLE_FORMAT,
  MarkdownArticleError,
  MarkdownCandidateSchema,
  splitMarkdownArticle,
} from "./markdown-article.js";
import type { WriterPackage } from "./writer-package.js";
import { MechanicalRecordSchema } from "./mechanical-record.js";
import { WriterAttemptManifestSchema } from "./writer-attempts.js";
import { artifactRef, sameArtifact } from "./publication-payload.js";

/** Structural safety only. Editorial findings are deliberately not an eligibility test. */
export async function readDraftMechanicalEvidence(input: {
  content: Pick<GitArtifactStore, "read">;
  request: { mechanicalRun: ArtifactReference; package: ArtifactReference };
  pkg: WriterPackage;
  metadata: z.infer<typeof PackageDraftMetadataSchema>;
  sourceUrl: string;
  markdown: string;
  allowedKinds: readonly string[];
  expectedRevision?: number;
  requiredContext?: ArtifactReference[];
}) {
  const { content, request, pkg, metadata, allowedKinds } = input;
  const read = async (ref: ArtifactReference) => JSON.parse(await content.read(artifactRef(ref)));
  const requireEvidence = (condition: unknown) => {
    if (!condition) throw new DraftMechanicalEvidenceError();
  };
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
      allowedKinds.includes(attempt.kind) &&
      attempt.number === turn.number &&
      sameArtifact(attempt.package, request.package) &&
      sameArtifact(attempt.source, pkg.source.artifact),
  );
  requireEvidence(attempt.revision === input.expectedRevision);
  for (const required of input.requiredContext ?? [])
    requireEvidence(attempt.context.some((ref) => sameArtifact(ref, required)));
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
      m.revision === attempt.revision &&
      JSON.stringify(m.context) === JSON.stringify(attempt.context)
    )
      accepted = true;
  }
  requireEvidence(accepted);
  const text = await content.read(artifactRef(turn.candidate ?? attempt.raw!));
  let raw: unknown;
  const isMarkdown = metadata.format === MARKDOWN_ARTICLE_FORMAT;
  if (isMarkdown && !turn.candidate) {
    let split: ReturnType<typeof splitMarkdownArticle>;
    try {
      split = splitMarkdownArticle(text);
    } catch (error) {
      if (error instanceof MarkdownArticleError) throw new DraftMechanicalEvidenceError();
      throw error;
    }
    requireEvidence(
      split.header && typeof split.header === "object" && !Array.isArray(split.header),
    );
    raw = { ...(split.header as Record<string, unknown>), body: split.body };
  } else
    try {
      raw = JSON.parse(text);
    } catch {
      raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    }
  const candidate = isMarkdown ? MarkdownCandidateSchema.parse(raw) : ModelDraftSchema.parse(raw);
  requireEvidence(
    draftProblems(
      pkg,
      isMarkdown
        ? markdownEvidenceView(MarkdownCandidateSchema.parse(candidate))
        : ModelDraftSchema.parse(candidate),
    ).length === 0 &&
      (isMarkdown
        ? markdownCitationIssues(MarkdownCandidateSchema.parse(candidate))
        : modelCitationProblems(ModelDraftSchema.parse(candidate))
      ).length === 0,
  );
  requireEvidence(
    JSON.stringify(metadata.fields) ===
      JSON.stringify({
        title: candidate.title,
        subtitle: candidate.subtitle,
        excerpt: candidate.excerpt,
      }),
  );
  const markdown = isMarkdown
    ? renderMarkdownDraft(pkg, MarkdownCandidateSchema.parse(candidate), input.sourceUrl)
    : renderPackageDraft(pkg, ModelDraftSchema.parse(candidate), input.sourceUrl);
  requireEvidence(markdown === input.markdown);
  return { markdown, candidate };
}
export class DraftMechanicalEvidenceError extends Error {
  constructor() {
    super("invalid draft mechanical evidence");
  }
}
