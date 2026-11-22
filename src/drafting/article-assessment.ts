import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExtractionModelProvider, ExtractionPrompt } from "../analysis/extraction.js";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { rethrowCreditExhausted } from "../observability/provider-condition.js";
import { loadPromptFile } from "../prompt-files.js";
import { writeOnce } from "../research/job.js";
import { artifactReference } from "./publication-payload.js";
import { deterministicIssues, loadArticleForReview } from "./package-verify.js";
import { promptIdentity } from "./prompt-identity.js";

/**
 * Findings-only article assessment (#598, child of #141).
 *
 * The assessor's single editorial job is to identify faults in one exact
 * saved article against its pinned source and evidence. It never suggests
 * improvements, requests a redraft or approves: what to do about findings is
 * a separately recorded judgement (#599), and orchestration is #600.
 *
 * Output is a human-readable Markdown findings document, retained as
 * received, plus small versioned metadata binding the exact body, publication
 * payload (title, subtitle, excerpt), package, source context, assessor model
 * and prompt identity, and completion state. A failed, malformed or cut-off
 * assessment can never read as "no faults": only a document that ends with the
 * required terminator and says "No faults found." is `no-faults`.
 *
 * Legacy combined verification reports are untouched and keep their meaning.
 */

export const DEFAULT_ASSESSOR_PROMPT = loadPromptFile("verifier", "article-assessor");
export const ASSESSMENT_SCHEMA_VERSION = 1;
const TERMINATOR = "END OF ASSESSMENT";

export type AssessmentState =
  | "findings"
  | "no-faults"
  | "incomplete"
  | "malformed"
  | "provider-failed";

const Ref = ArtifactReferenceSchema;

export const AssessmentRecordSchema = z
  .object({
    schemaVersion: z.literal(ASSESSMENT_SCHEMA_VERSION),
    state: z.enum(["findings", "no-faults", "incomplete", "malformed", "provider-failed"]),
    /** Number of `## Finding` sections in a complete document. */
    findings: z.number().int().min(0).optional(),
    /** Deterministic quotation/citation/provenance faults found without the model. */
    deterministicFindings: z
      .array(z.object({ passage: z.string(), reason: z.string() }).strict())
      .max(200),
    /** The exact findings document as received; absent when the provider failed. */
    document: Ref.optional(),
    body: Ref,
    publication: Ref,
    package: Ref,
    source: Ref,
    sourceContext: Ref.optional(),
    contextVersion: z.string(),
    assessor: z.object({ model: z.string(), promptVersion: z.string() }).strict(),
    assessedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type AssessmentRecord = z.infer<typeof AssessmentRecordSchema>;

export type AssessmentOutcome =
  | { status: "assessed"; record: AssessmentRecord; ref: ArtifactRef; reused: boolean }
  | { status: "context-unavailable"; reason: string };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const toRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

/** Classify a findings document without trusting it to say it is complete. */
export function classifyFindings(document: string): {
  state: "findings" | "no-faults" | "incomplete" | "malformed";
  findings?: number;
} {
  const text = document.trim();
  const lines = text.split(/\r?\n/);
  if (lines.at(-1)?.trim() !== TERMINATOR) return { state: "incomplete" };
  const body = lines.slice(0, -1).join("\n");
  const findings = (body.match(/^##\s+Finding\b/gm) ?? []).length;
  if (findings > 0) return { state: "findings", findings };
  // A clean assessment is exactly the prescribed sentence and nothing else:
  // an incidental or qualified phrase ("No faults found in the title, but…")
  // never counts as clean.
  return /^No faults found\.?$/i.test(body.trim())
    ? { state: "no-faults", findings: 0 }
    : { state: "malformed" };
}

export async function assessArticle(input: {
  content: GitArtifactStore;
  archive: Pick<GitArtifactStore, "read">;
  /** The draft's metadata, which pins body, package and context. */
  metadata: ArtifactRef;
  assessor: ExtractionModelProvider;
  prompt?: ExtractionPrompt;
  now?: () => Date;
}): Promise<AssessmentOutcome> {
  const prompt = input.prompt ?? DEFAULT_ASSESSOR_PROMPT;
  const bound = await loadArticleForReview(input);
  if (bound.status !== "loaded") return bound;
  const { meta, draftRef, markdown, pkg, publication, loaded } = bound;
  const promptId = promptIdentity(prompt.version, prompt.instructions);
  const key = sha(
    JSON.stringify([
      "assessment-v1",
      toRef(draftRef),
      artifactReference(publication.ref),
      meta.package,
      input.assessor.modelVersion,
      promptId,
      loaded.context.contextRef,
    ]),
  ).slice(0, 32);
  const dir = `assessments/${pkg.post.publicationId}/${pkg.post.postId}`;
  const recordPath = `${dir}/${key}.json`;

  // A completed assessment of this exact input is reused, never repeated.
  const saved = await input.content.lookup(recordPath);
  if (saved) {
    const record = AssessmentRecordSchema.parse(JSON.parse(await input.content.read(saved)));
    return { status: "assessed", record, ref: saved, reused: true };
  }

  const deterministic = deterministicIssues(pkg, markdown).map((i) => ({
    passage: i.passage,
    reason: i.reason,
  }));
  const user = JSON.stringify({
    article: markdown,
    publication:
      publication.payload.mode === "structured"
        ? { mode: "structured", ...publication.payload.fields }
        : { mode: "legacy-body-only" },
    post: loaded.context.source.text,
    sourceContext: loaded.context.source.provenance,
    themes: loaded.context.themes.proposals.map((t) => t.title),
    claims: pkg.claims.map((c) => ({
      statement: c.statement,
      status: c.status,
      coverage: c.coverage,
      ...(c.reason ? { reason: c.reason } : {}),
      evidence: c.evidence.map((e) => ({ url: e.url, passage: e.passage })),
    })),
    history: pkg.context?.history ?? { status: "gap" },
    background: pkg.context?.background ?? { status: "gap" },
  });

  // A response retained before a crash is reused: never pay for it twice.
  const documentPath = `${dir}/${key}.md`;
  const retained = await input.content.lookup(documentPath);
  let raw: string | undefined = retained ? await input.content.read(retained) : undefined;
  if (raw === undefined) {
    try {
      raw = await input.assessor.complete(
        { system: prompt.instructions, user, maxOutputChars: 60_000 },
        AbortSignal.timeout(180_000),
      );
    } catch (error) {
      rethrowCreditExhausted(error); // waits for credit; never flattened (#407)
      raw = undefined;
    }
  }

  // Retain the exact response before interpreting it.
  const document =
    raw === undefined
      ? undefined
      : (retained ?? (await writeOnce(input.content, documentPath, raw)));
  const verdict = raw === undefined ? { state: "provider-failed" as const } : classifyFindings(raw);
  const record: AssessmentRecord = AssessmentRecordSchema.parse({
    schemaVersion: ASSESSMENT_SCHEMA_VERSION,
    state: verdict.state,
    ...("findings" in verdict && verdict.findings !== undefined
      ? { findings: verdict.findings }
      : {}),
    deterministicFindings: deterministic,
    ...(document ? { document: toRef(document) } : {}),
    body: toRef(draftRef),
    publication: artifactReference(publication.ref),
    package: meta.package,
    source: pkg.source.artifact,
    ...(pkg.source.context ? { sourceContext: pkg.source.context } : {}),
    contextVersion: loaded.context.contextRef,
    assessor: { model: input.assessor.modelVersion, promptVersion: promptId },
    assessedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  // A provider failure is kept as its own write-once attempt record (with its
  // deterministic findings and provenance), outside the success path, so the
  // exact input stays retryable and nothing about the attempt is lost.
  if (record.state === "provider-failed") {
    const attempt = sha(`${record.assessedAt}:${Math.random()}`).slice(0, 16);
    const ref = await writeOnce(input.content, `${dir}/${key}.failed/${attempt}.json`, record);
    return { status: "assessed", record, ref, reused: false };
  }
  const ref = await writeOnce(input.content, recordPath, record);
  return { status: "assessed", record, ref, reused: false };
}
