import { JudgmentHistorySchema, type JudgmentHistory } from "../content/judgment-history.js";
import { parseJudgmentDocument } from "./judgment-document.js";
import { rethrowEditorialStorageError } from "./editorial-provider.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExtractionModelProvider, ExtractionPrompt } from "../analysis/extraction.js";
import { type ArtifactReference, ArtifactReferenceSchema } from "../content/artifact-reference.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import { rethrowCreditExhausted, isCreditExhausted } from "../observability/provider-condition.js";
import { loadPromptFile } from "../prompt-files.js";
import { writeOnce } from "../research/job.js";
import { AssessmentRecordSchema } from "./article-assessment.js";
import { readPublicationPayload, sameArtifact } from "./publication-payload.js";
import { promptIdentity } from "./prompt-identity.js";

/**
 * Separately recorded editorial judgement over saved assessment findings
 * (#599, child of #141; consumes #598).
 *
 * The judge reads the exact article and the assessor's saved findings and
 * decides: APPROVE, or REQUEST REVISION with reasons and recommended changes.
 * A model may interpret materiality through its own versioned Markdown policy
 * prompt, but the gates that decide whether approval is even possible are
 * deterministic and never delegated to model text:
 *
 * - the assessment must be complete (`findings` or `no-faults`) and still
 *   bound to readable bytes of the exact article it assessed;
 * - deterministic quotation/citation/provenance faults always block;
 * - the model's document must end with a valid decision line.
 *
 * Approval binds the exact reviewed body, publication payload, assessment and
 * judge policy/prompt identity: a policy change is a new judgement, never a
 * silent reuse of an older approval. The revision bound and unresolved stop
 * are enforced by orchestration (#600), not here.
 */

export const DEFAULT_JUDGE_PROMPT = loadPromptFile("verifier", "editorial-judge");
export const JUDGMENT_SCHEMA_VERSION = 1;

const Ref = ArtifactReferenceSchema;

export const JudgmentRecordSchema = z
  .object({
    schemaVersion: z.literal(JUDGMENT_SCHEMA_VERSION),
    attemptId: z.string().min(1).max(500).optional(),
    operationalFailure: z.literal("credit-exhausted").optional(),
    retainedAttempts: z.array(Ref).max(10).optional(),
    retainedAttemptReuses: z.array(z.boolean().nullable()).max(10).optional(),
    /** The disposition; `none` whenever approval or revision could not be decided. */
    decision: z.enum(["approve", "revise", "none"]),
    state: z.enum(["decided", "gated", "malformed", "provider-failed"]),
    /** Why a gate prevented approval (deterministic, fixed reasons). */
    gates: z.array(z.string()).max(20),
    /** The judge's Markdown reasons and recommendations, retained as received. */
    document: Ref.optional(),
    assessment: Ref,
    history: JudgmentHistorySchema.optional(),
    body: Ref,
    publication: Ref,
    judge: z.object({ model: z.string(), promptVersion: z.string() }).strict().optional(),
    decidedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type JudgmentRecord = z.infer<typeof JudgmentRecordSchema>;

export type JudgmentOutcome =
  | { status: "judged"; record: JudgmentRecord; ref: ArtifactRef; reused: boolean }
  | { status: "unavailable"; reason: string };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fromRef = (r: { repository: string; commit: string; path: string; hash: string }) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.hash.replace(/^sha256:/, ""),
});
const toRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});

/** Legacy public decision reader uses the same complete section parser as revision handoff. */
export function readDecision(document: string): "approve" | "revise" | undefined {
  return parseJudgmentDocument(document)?.decision;
}

export async function judgeAssessment(input: {
  content: GitArtifactStore;
  /** The saved assessment record (#598) to judge. */
  assessment: ArtifactRef;
  judge: ExtractionModelProvider;
  attemptId?: string;
  history?: JudgmentHistory;
  retainOperationalFailure?: boolean;
  retainedAttempts?: () => ArtifactReference[];
  retainedAttemptReuses?: () => Array<boolean | null>;
  prompt?: ExtractionPrompt;
  now?: () => Date;
}): Promise<JudgmentOutcome> {
  const prompt = input.prompt ?? DEFAULT_JUDGE_PROMPT;
  const now = () => (input.now ?? (() => new Date()))().toISOString();
  let assessment;
  try {
    assessment = AssessmentRecordSchema.parse(
      JSON.parse(await input.content.read(input.assessment)),
    );
  } catch {
    return { status: "unavailable", reason: "assessment-unreadable" };
  }
  let history: JudgmentHistory;
  try {
    history = JudgmentHistorySchema.parse(input.history ?? []);
  } catch {
    return { status: "unavailable", reason: "judgment-history-invalid" };
  }
  const promptId = promptIdentity(prompt.version, prompt.instructions);
  const pub = assessment.body.path.split("/");
  const dir = `judgments/${pub[1] ?? "unknown"}/${pub[2] ?? "unknown"}`;
  const key = sha(
    JSON.stringify([
      "judgment-v1",
      ...(input.attemptId ? [input.attemptId] : []),
      toRef(input.assessment),
      assessment.body,
      assessment.publication,
      input.judge.modelVersion,
      promptId,
      ...(history.length ? [history] : []),
    ]),
  ).slice(0, 32);
  const recordPath = `${dir}/${key}.json`;
  const saved = await input.content.lookup(recordPath);
  if (saved) {
    const record = JudgmentRecordSchema.parse(JSON.parse(await input.content.read(saved)));
    return { status: "judged", record, ref: saved, reused: true };
  }

  const persist = async (record: JudgmentRecord) => {
    const ref = await writeOnce(
      input.content,
      recordPath,
      JudgmentRecordSchema.parse({
        ...record,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ...(input.retainedAttempts ? { retainedAttempts: input.retainedAttempts() } : {}),
        ...(input.retainedAttemptReuses
          ? { retainedAttemptReuses: input.retainedAttemptReuses() }
          : {}),
      }),
    );
    const persisted = JudgmentRecordSchema.parse(JSON.parse(await input.content.read(ref)));
    return { status: "judged" as const, record: persisted, ref, reused: false };
  };
  const base = {
    schemaVersion: JUDGMENT_SCHEMA_VERSION,
    assessment: toRef(input.assessment),
    ...(history.length ? { history } : {}),
    body: assessment.body,
    publication: assessment.publication,
  } as const;

  // Deterministic gates: an incomplete or mismatched assessment, or a
  // deterministic quotation/citation fault, can never approve.
  const gates: string[] = [];
  if (assessment.state !== "findings" && assessment.state !== "no-faults") {
    gates.push(`assessment-${assessment.state}`);
  }
  let article: string | undefined;
  let findings: string | undefined;
  try {
    article = await input.content.read(fromRef(assessment.body));
  } catch {
    gates.push("article-version-unreadable");
  }
  if (assessment.document) {
    try {
      findings = await input.content.read(fromRef(assessment.document));
    } catch {
      gates.push("findings-unreadable");
    }
  } else if (assessment.state === "findings" || assessment.state === "no-faults") {
    gates.push("findings-missing");
  }
  // The exact publication fields the assessment covered: loaded, validated
  // and checked against the same body, so approval never covers unseen fields.
  let publication: Record<string, unknown> | undefined;
  try {
    const { payload } = await readPublicationPayload(input.content, assessment.publication);
    if (!sameArtifact(payload.body, assessment.body)) gates.push("publication-body-mismatch");
    else
      publication =
        payload.mode === "structured"
          ? { mode: "structured", ...payload.fields }
          : { mode: "legacy-body-only" };
  } catch {
    gates.push("publication-unreadable");
  }
  const priorGuidance = [];
  for (const item of history) {
    try {
      const prior = JudgmentRecordSchema.parse(
        JSON.parse(await input.content.read(fromRef(item.judgment))),
      );
      const priorAssessment = AssessmentRecordSchema.parse(
        JSON.parse(await input.content.read(fromRef(item.assessment))),
      );
      const { payload } = await readPublicationPayload(input.content, prior.publication);
      if (
        prior.state !== "decided" ||
        prior.decision !== "revise" ||
        !prior.document ||
        !sameArtifact(prior.assessment, item.assessment) ||
        !sameArtifact(prior.body, item.body) ||
        !sameArtifact(priorAssessment.body, item.body) ||
        !sameArtifact(priorAssessment.publication, prior.publication) ||
        !sameArtifact(priorAssessment.package, assessment.package) ||
        !sameArtifact(priorAssessment.source, assessment.source) ||
        JSON.stringify(priorAssessment.sourceContext ?? null) !==
          JSON.stringify(assessment.sourceContext ?? null) ||
        item.body.repository !== assessment.body.repository ||
        item.body.path !== assessment.body.path ||
        !sameArtifact(payload.body, item.body) ||
        !sameArtifact(payload.metadata, item.metadata)
      )
        throw new Error("history-mismatch");
      const document = await input.content.read(fromRef(prior.document)),
        guidance = parseJudgmentDocument(document);
      if (!guidance) throw new Error("history-incomplete");
      priorGuidance.push({
        ...item,
        effectiveDecision: prior.decision,
        deterministicGates: prior.gates,
        requiredCorrections: guidance.requiredCorrections,
        acceptedMinorObservations: guidance.acceptedMinorObservations,
      });
    } catch (error) {
      if (
        error instanceof ArtifactStoreError &&
        ["git-failed", "concurrent-update", "interrupted-commit"].includes(error.code)
      )
        throw error;
      gates.push("judgment-history-unreadable-or-mismatched");
      break;
    }
  }
  const blockingDeterministic = assessment.deterministicFindings.length > 0;

  // Nothing to judge: record the gated state without calling the model.
  if (gates.length > 0 || article === undefined || findings === undefined || !publication) {
    return persist({ ...base, decision: "none", state: "gated", gates, decidedAt: now() });
  }

  const user = JSON.stringify({
    article,
    publication,
    findings,
    deterministicFindings: assessment.deterministicFindings,
    ...(priorGuidance.length ? { priorJudgmentGuidance: priorGuidance } : {}),
  });
  const documentPath = `${dir}/${key}.md`;
  const retained = await input.content.lookup(documentPath);
  let raw: string | undefined = retained ? await input.content.read(retained) : undefined;
  let operationalFailure: "credit-exhausted" | undefined;
  if (raw === undefined) {
    try {
      raw = await input.judge.complete(
        { system: prompt.instructions, user, maxOutputChars: 40_000 },
        AbortSignal.timeout(180_000),
      );
    } catch (error) {
      rethrowEditorialStorageError(error);
      if (input.retainOperationalFailure && isCreditExhausted(error))
        operationalFailure = "credit-exhausted";
      else rethrowCreditExhausted(error);
      raw = undefined;
    }
  }
  const judge = { model: input.judge.modelVersion, promptVersion: promptId };
  if (raw === undefined) {
    // A failed attempt is kept apart from the success path, which stays retryable.
    const record = JudgmentRecordSchema.parse({
      ...base,
      decision: "none",
      state: "provider-failed",
      gates: [],
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.retainedAttempts ? { retainedAttempts: input.retainedAttempts() } : {}),
      ...(input.retainedAttemptReuses
        ? { retainedAttemptReuses: input.retainedAttemptReuses() }
        : {}),
      ...(operationalFailure ? { operationalFailure } : {}),
      judge,
      decidedAt: now(),
    });
    const ref = await writeOnce(
      input.content,
      `${dir}/${key}.failed/${sha(`${record.decidedAt}:${Math.random()}`).slice(0, 16)}.json`,
      record,
    );
    return { status: "judged", record, ref, reused: false };
  }
  const document = retained ?? (await writeOnce(input.content, documentPath, raw));
  // Decide from the document actually retained.
  const decided = readDecision(await input.content.read(document));
  if (!decided) {
    return persist({
      ...base,
      decision: "none",
      state: "malformed",
      gates: [],
      document: toRef(document),
      judge,
      decidedAt: now(),
    });
  }
  // A deterministic fault overrides a model approval.
  const decision = decided === "approve" && blockingDeterministic ? "revise" : decided;
  return persist({
    ...base,
    decision,
    state: "decided",
    gates: decision !== decided ? ["deterministic-fault-blocks-approval"] : [],
    document: toRef(document),
    judge,
    decidedAt: now(),
  });
}
