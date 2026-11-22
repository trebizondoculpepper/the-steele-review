import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import {
  ModelDraftSchema,
  draftProblems,
  modelCitationProblems,
  renderPackageDraft,
  PackageDraftMetadataSchema,
} from "./package-draft.js";
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
  const markdown = renderPackageDraft(pkg, candidate, input.sourceUrl);
  requireEvidence(markdown === input.markdown);
  return { markdown, candidate };
}
export class DraftMechanicalEvidenceError extends Error {
  constructor() {
    super("invalid draft mechanical evidence");
  }
}
