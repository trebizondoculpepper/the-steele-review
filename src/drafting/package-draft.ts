import { createHash } from "node:crypto";
import { z } from "zod";
import { loadPromptFile } from "../prompt-files.js";
import {
  safeDraftIssues,
  saveDraftDiagnostic,
  type DraftValidationKind,
  type SafeDraftIssue,
} from "./draft-diagnostics.js";
import { PublicationFieldsSchema } from "../content/publication-fields.js";
export { FIELD_LIMITS } from "../content/publication-fields.js";
import type { ExtractionModelProvider, ExtractionPrompt } from "../analysis/extraction.js";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { ModelProviderError } from "../controllers/openrouter.js";
import { writeOnce } from "../research/job.js";
import { loadPinnedContext } from "./pinned-context.js";
import { promptIdentity } from "./prompt-identity.js";
import { rethrowCreditExhausted } from "../observability/provider-condition.js";
import { WriterPackageSchema, type WriterPackage } from "./writer-package.js";

/**
 * Draft one article from a saved writer package (#149).
 *
 * The writer receives the exact package (#148) plus the pinned full source
 * text and saved themes (#164). It may select the relevant, evidence-supported
 * subset of claims; every response it writes is validated against the
 * package before the draft is saved:
 * - a response may cite only evidence the package holds for that claim;
 * - a claim with an evidence gap can only be acknowledged as unresolved, never
 *   corrected or confirmed, and carries no citations;
 * - unknown claims, unknown evidence and malformed output are rejected.
 *
 * Template (package-explainer-v1): original link and a fair summary of the
 * whole post, its themes, then claim-by-claim responses. The draft is saved
 * write-once under articles/ at a path derived from the exact package, model
 * and prompt, so retries reuse it without another model call; a new package
 * or prompt yields a new draft and older drafts stay readable.
 */

export const PACKAGE_DRAFT_TEMPLATE_VERSION = "package-explainer-v5";
/** Bound on the previous draft text sent to the revision writer. */
export const MAX_PREVIOUS_DRAFT_CHARS = 40_000;
export const PACKAGE_DRAFT_SCHEMA_VERSION = 1;

/** Revision instructions for redrafts (#150), from their own editable Markdown file. */
const PACKAGE_REVISION_PROMPT = loadPromptFile("writer", "package-revision");
const OUTPUT_REPAIR_PROMPT = loadPromptFile("writer", "package-output-repair");
export const PACKAGE_OUTPUT_REPAIR_ID = promptIdentity(
  OUTPUT_REPAIR_PROMPT.version,
  OUTPUT_REPAIR_PROMPT.instructions,
);
export const PACKAGE_REVISION_INSTRUCTIONS = PACKAGE_REVISION_PROMPT.instructions;
/** Identity of the revision instructions; part of a redraft's identity. */
export const PACKAGE_REVISION_PROMPT_VERSION = PACKAGE_REVISION_PROMPT.version;

/** The writer prompt for package drafts, loaded from its editable Markdown file. */
export const DEFAULT_PACKAGE_DRAFT_PROMPT = loadPromptFile("writer", "package-explainer");

const ModelDraftSchema = z
  .object({
    title: PublicationFieldsSchema.shape.title,
    subtitle: PublicationFieldsSchema.shape.subtitle,
    excerpt: PublicationFieldsSchema.shape.excerpt,
    summary: z.string().trim().min(1).max(3000),
    themes: z.array(z.string().trim().min(1).max(200)).max(20),
    responses: z
      .array(
        z
          .object({
            claimRecordId: z.string().min(1),
            verdict: z.enum(["supported", "contradicted", "unsupported", "unresolved"]),
            text: z.string().trim().min(1).max(3000),
            evidence: z.array(z.number().int().min(0)).max(20),
          })
          .strict(),
      )
      .max(50),
    limitations: z.array(z.string().trim().min(1).max(1000)).max(20),
    /**
     * How the post develops the author's narrative (#176): "supported" only
     * with cited earlier passages from the package; otherwise "limited".
     */
    narrative: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("supported"),
          text: z.string().trim().min(1).max(3000),
          history: z.array(z.number().int().min(0)).min(1).max(20),
        })
        .strict(),
      z
        .object({ status: z.literal("limited"), limitation: z.string().trim().min(1).max(1000) })
        .strict(),
    ]),
    /** Significance within the wider movement (#176): "supported" only with cited background. */
    widerContext: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("supported"),
          text: z.string().trim().min(1).max(3000),
          background: z.array(z.number().int().min(0)).min(1).max(30),
        })
        .strict(),
      z
        .object({ status: z.literal("limited"), limitation: z.string().trim().min(1).max(1000) })
        .strict(),
    ]),
  })
  .strict();
export type PackageModelDraft = z.infer<typeof ModelDraftSchema>;

const Ref = z
  .object({ repository: z.string(), commit: z.string(), path: z.string(), hash: z.string() })
  .strict();

export const PackageDraftMetadataSchema = z
  .object({
    schemaVersion: z.literal(PACKAGE_DRAFT_SCHEMA_VERSION),
    package: Ref,
    source: Ref,
    themes: Ref,
    templateVersion: z.string(),
    promptVersion: z.string(),
    /** Revision instructions identity, for redrafts only (#430). */
    revisionPromptVersion: z.string().optional(),
    repairPromptVersion: z.string().optional(),
    diagnostics: z.array(Ref).max(2).optional(),
    modelVersion: z.string(),
    /** Model the caller asked for (#260); absent when the configured default was used. */
    requestedModel: z.string().optional(),
    /** Model the provider reports it actually served. */
    resolvedModel: z.string().optional(),
    draft: z.string(),
    /**
     * Generated publication fields (#456). Absent on drafts made before the
     * fields existed; the body is the draft Markdown itself.
     */
    fields: PublicationFieldsSchema.optional(),
    draftedAt: z.string(),
  })
  .strict();

export class InvalidDraftError extends Error {
  constructor(reason: string) {
    super(`draft rejected: ${reason}`);
    this.name = "InvalidDraftError";
  }
}

/** Validate a model draft against the package; returns problems (empty when valid). */
export function draftProblems(pkg: WriterPackage, draft: PackageModelDraft): string[] {
  const problems: string[] = [];
  // Narrative and wider context may be asserted only from the package's own
  // cited context; without it they must be stated as limitations (#176).
  const history = pkg.context?.history.comparisons ?? [];
  const background = pkg.context?.background.passages ?? [];
  if (draft.narrative?.status === "supported") {
    if (history.length === 0)
      problems.push("narrative development asserted without historical evidence");
    for (const i of draft.narrative.history) {
      if (i >= history.length) problems.push(`narrative cites unknown comparison ${i}`);
    }
  }
  if (draft.widerContext?.status === "supported") {
    if (background.length === 0)
      problems.push("wider context asserted without independent background");
    for (const i of draft.widerContext.background) {
      if (i >= background.length) problems.push(`wider context cites unknown background ${i}`);
    }
  }
  const claims = new Map(pkg.claims.map((c) => [c.claimRecordId, c]));
  const seen = new Set<string>();
  for (const r of draft.responses) {
    const claim = claims.get(r.claimRecordId);
    if (!claim) {
      problems.push(`unknown claim ${r.claimRecordId}`);
      continue;
    }
    if (seen.has(r.claimRecordId)) problems.push(`claim ${r.claimRecordId} answered twice`);
    seen.add(r.claimRecordId);
    if (claim.status === "gap") {
      // A gap is a limitation, never a correction or confirmation.
      if (r.verdict !== "unresolved")
        problems.push(`gap claim ${r.claimRecordId} given verdict ${r.verdict}`);
      if (r.evidence.length > 0) problems.push(`gap claim ${r.claimRecordId} cites evidence`);
      continue;
    }
    for (const i of r.evidence) {
      if (i >= claim.evidence.length)
        problems.push(`claim ${r.claimRecordId} cites unknown evidence ${i}`);
    }
    if (r.verdict !== "unresolved" && r.evidence.length === 0) {
      problems.push(`claim ${r.claimRecordId} has verdict ${r.verdict} without evidence`);
    }
  }
  return problems;
}

/** Readable Markdown with numbered sources traceable to the package's evidence. */
export function renderPackageDraft(
  pkg: WriterPackage,
  draft: PackageModelDraft,
  sourceUrl: string,
): string {
  const linkText = (pkg.source.title ?? sourceUrl).replace(/[\\[\]]/g, (c) => `\\${c}`);
  const claims = new Map(pkg.claims.map((c) => [c.claimRecordId, c]));
  const sources: { url: string; passage: string; archived?: string }[] = [];
  const index = new Map<string, number>();
  const cite = (url: string, passage: string, archived?: string) => {
    const key = JSON.stringify([url, passage]);
    if (!index.has(key)) {
      sources.push({ url, passage, ...(archived ? { archived } : {}) });
      index.set(key, sources.length);
    }
    return index.get(key)!;
  };
  const lines = [draft.summary, ""];
  for (const r of draft.responses) {
    const claim = claims.get(r.claimRecordId)!;
    const refs = r.evidence.map((i) => {
      const e = claim.evidence[i];
      return cite(
        e.url,
        e.passage,
        e.archived ? `${e.archived.commit.slice(0, 12)}:${e.archived.path}` : undefined,
      );
    });
    lines.push(
      `<!-- claim-verdict ${Buffer.from(r.claimRecordId).toString("hex")} ${r.verdict} -->`,
      "",
      `${r.text}${refs.length > 0 ? ` ${refs.map((n) => `[${n}]`).join("")}` : ""}`,
      "",
    );
  }
  // Narrative development: earlier passages are quoted evidence (dated,
  // linked); the comparison text is generated analysis, labelled as such.
  // An unattended run leaves absent history out of the article entirely (#370).
  const omitNarrative =
    pkg.context?.history.status === "gap" && pkg.context.history.omitWhenAbsent === true;
  if (draft.narrative && !omitNarrative) {
    if (draft.narrative.status === "limited") {
      lines.push(draft.narrative.limitation, "");
    } else {
      lines.push(draft.narrative.text, "");
      const comparisons = pkg.context?.history.comparisons ?? [];
      for (const i of draft.narrative.history) {
        const c = comparisons[i];
        for (const e of c.earlier) {
          lines.push(`> "${e.quote}" (${e.publishedAt}${e.url ? `, ${e.url}` : ""})`, "");
        }
        lines.push(
          `_Comparison (${c.kind}, ${c.uncertainty} uncertainty; analysis, not evidence): ${c.comparison.text}_`,
          "",
        );
        if (c.conflictRationale) lines.push(`_Qualification: ${c.conflictRationale}_`, "");
        if (c.changedCircumstances)
          lines.push(`_Changed circumstances: ${c.changedCircumstances}_`, "");
      }
    }
  }
  if (draft.widerContext) {
    if (draft.widerContext.status === "limited") {
      lines.push(draft.widerContext.limitation, "");
    } else {
      const passages = pkg.context?.background.passages ?? [];
      const refs = draft.widerContext.background.map((i) =>
        cite(passages[i].url, passages[i].passage),
      );
      lines.push(`${draft.widerContext.text} ${refs.map((n) => `[${n}]`).join("")}`, "");
    }
  }
  for (const limitation of draft.limitations) lines.push(limitation, "");
  lines.push("## Sources", "", `Original post: [${linkText}](<${sourceUrl}>)`, "");
  if (sources.length > 0) {
    lines.push(
      ...sources.map(
        (s, i) =>
          `${i + 1}. ${s.url}${s.archived ? ` (archived ${s.archived})` : ""}: "${s.passage}"`,
      ),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const toRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const toArtifactRef = (r: z.infer<typeof Ref>): ArtifactRef => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.hash.replace(/^sha256:/, ""),
});

export type PackageDraftOutcome =
  | {
      status: "drafted";
      draft: ArtifactRef;
      metadata: ArtifactRef;
      reused: boolean;
      diagnostics?: ArtifactRef[];
    }
  | { status: "evidence-gap" }
  | { status: "context-unavailable"; reason: string }
  | {
      status: "failed";
      reason:
        | "provider-failed"
        | "malformed-output"
        | "invalid-draft"
        /** The caller's link differs from the package's pinned original URL (#276). */
        | "source-url-mismatch"
        /** Neither the package nor the caller supplies the original post's link. */
        | "no-source-url";
      problems?: string[];
      /** Sanitised provider error code, e.g. "bad-request" for an unknown model. */
      providerError?: string;
      validationFailure?: DraftValidationKind;
      diagnostics?: ArtifactRef[];
    };

export async function draftFromPackage(input: {
  content: GitArtifactStore;
  archive: Pick<GitArtifactStore, "read">;
  package: ArtifactRef;
  provider: ExtractionModelProvider;
  /**
   * Public link to the original post. Packages from #276 on carry it; then it
   * is optional here and refused when it differs. Required for older packages.
   */
  sourceUrl?: string;
  /** Model ID the caller requested (#260); recorded as provenance. */
  requestedModel?: string;
  /** Reports the model the provider actually served, once a call has succeeded. */
  resolvedModel?: () => string | undefined;
  prompt?: ExtractionPrompt;
  /** May lower, but never increase, the existing two-call attempt budget. */
  maxAttempts?: number;
  /**
   * Verifier feedback for a redraft (#150): the passages and reasons to fix.
   * Part of the draft's identity, so each revision is a new, separately saved draft.
   */
  revision?: { number: number; feedback: { passage: string; reason: string }[] };
  /**
   * The exact immediately preceding saved draft (#489). The writer revises
   * that article; it is not asked to regenerate from feedback alone. Its
   * reference is part of this draft's identity.
   */
  previousDraft?: { ref: ArtifactRef; markdown: string };
  /** Revision instructions; defaults to the editable package-revision.md. */
  revisionInstructions?: string;
  now?: () => Date;
}): Promise<PackageDraftOutcome> {
  const prompt = input.prompt ?? DEFAULT_PACKAGE_DRAFT_PROMPT;
  const pkg = WriterPackageSchema.parse(JSON.parse(await input.content.read(input.package)));
  if (pkg.status !== "ready") return { status: "evidence-gap" };
  const pinnedUrl = pkg.source.originalUrl;
  if (pinnedUrl && input.sourceUrl && input.sourceUrl !== pinnedUrl)
    return { status: "failed", reason: "source-url-mismatch" };
  const sourceUrl = pinnedUrl ?? input.sourceUrl;
  if (!sourceUrl) return { status: "failed", reason: "no-source-url" };

  // Bound to the exact wording, not only the semantic version (#430).
  const promptId = promptIdentity(prompt.version, prompt.instructions);
  const revisionInstructions = input.revisionInstructions ?? PACKAGE_REVISION_INSTRUCTIONS;
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        toRef(input.package),
        input.provider.modelVersion,
        promptId,
        PACKAGE_DRAFT_TEMPLATE_VERSION,
        ...(input.revision
          ? [
              input.revision,
              promptIdentity(PACKAGE_REVISION_PROMPT_VERSION, revisionInstructions),
              ...(input.previousDraft ? [toRef(input.previousDraft.ref)] : []),
            ]
          : []),
        // A package without a pinned URL takes it from the caller: part of the identity.
        ...(pinnedUrl ? [] : [sourceUrl]),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const base = `articles/${pkg.post.publicationId}/${pkg.post.postId}/${key}`;
  const repairedKey = createHash("sha256")
    .update(JSON.stringify([key, PACKAGE_OUTPUT_REPAIR_ID]))
    .digest("hex")
    .slice(0, 32);
  const repairedBase = `articles/${pkg.post.publicationId}/${pkg.post.postId}/${repairedKey}`;
  // Stable input identity: a saved draft for exactly these inputs is reused.
  const savedDraft = await input.content.lookup(`${base}.md`);
  const savedMeta = await input.content.lookup(`${base}.json`);
  if (savedDraft && savedMeta)
    return { status: "drafted", draft: savedDraft, metadata: savedMeta, reused: true };
  const repairedDraft = await input.content.lookup(`${repairedBase}.md`);
  const repairedMeta = await input.content.lookup(`${repairedBase}.json`);
  if (repairedDraft && repairedMeta)
    return {
      status: "drafted",
      draft: repairedDraft,
      metadata: repairedMeta,
      reused: true,
      diagnostics: PackageDraftMetadataSchema.parse(
        JSON.parse(await input.content.read(repairedMeta)),
      ).diagnostics?.map(toArtifactRef),
    };

  const loaded = await loadPinnedContext({
    archive: input.archive,
    content: input.content,
    brief: {
      source: {
        publicationId: pkg.post.publicationId,
        postId: pkg.post.postId,
        url: sourceUrl,
        sourceVersion: pkg.source.sourceVersion,
        artifact: pkg.source.artifact,
        ingestionReason: "backfill",
      },
    },
    themes: toArtifactRef(pkg.themeResult),
  });
  if (loaded.kind !== "loaded") return { status: "context-unavailable", reason: loaded.kind };

  const user = JSON.stringify({
    post: { url: sourceUrl, text: loaded.context.source.text },
    themes: loaded.context.themes.proposals.map((t) => ({
      title: t.title,
      description: t.description,
    })),
    claims: pkg.claims.map((c) => ({
      claimRecordId: c.claimRecordId,
      statement: c.statement,
      status: c.status,
      ...(c.reason ? { gapReason: c.reason } : {}),
      evidence: c.evidence.map((e, i) => ({ index: i, url: e.url, passage: e.passage })),
    })),
    history:
      pkg.context?.history.status === "available"
        ? pkg.context.history.comparisons.map((c, i) => ({
            index: i,
            kind: c.kind,
            ...(c.pattern ? { pattern: c.pattern } : {}),
            uncertainty: c.uncertainty,
            earlier: c.earlier.map((e) => ({ publishedAt: e.publishedAt, quote: e.quote })),
            comparison: c.comparison.text,
            ...(c.conflictRationale ? { qualification: c.conflictRationale } : {}),
            ...(c.changedCircumstances ? { changedCircumstances: c.changedCircumstances } : {}),
          }))
        : {
            gap: pkg.context?.history.reason ?? "no historical comparison",
            ...(pkg.context?.history.omitWhenAbsent ? { omit: true } : {}),
          },
    background:
      pkg.context?.background.status === "available"
        ? pkg.context.background.passages.map((p, i) => ({
            index: i,
            url: p.url,
            passage: p.passage,
          }))
        : { gap: pkg.context?.background.reason ?? "no independent background" },
    ...(input.revision
      ? {
          revision: {
            number: input.revision.number,
            instruction: revisionInstructions,
            feedback: input.revision.feedback,
            ...(input.previousDraft
              ? {
                  previousDraft: input.previousDraft.markdown.slice(0, MAX_PREVIOUS_DRAFT_CHARS),
                  previousDraftTruncated:
                    input.previousDraft.markdown.length > MAX_PREVIOUS_DRAFT_CHARS,
                }
              : {}),
          },
        }
      : {}),
  });
  let draft: PackageModelDraft | undefined;
  let lastProblems: string[] = [];
  let lastFailure: "provider-failed" | "malformed-output" | "invalid-draft" = "malformed-output";
  let providerError: string | undefined;
  const diagnostics: ArtifactRef[] = [];
  let correction:
    | { previousOutput: string; kind: DraftValidationKind; issues: SafeDraftIssue[] }
    | undefined;
  let repaired = false;
  let validationFailure: DraftValidationKind | undefined;
  const attempts = Math.min(2, Math.max(0, input.maxAttempts ?? 2));
  for (let attempt = 0; attempt < attempts && !draft; attempt++) {
    let raw: string;
    let completion: "completed" | "length-limit" | "unknown" = "unknown";
    const isCorrection = correction !== undefined;
    const requestUser = correction
      ? JSON.stringify({ ...JSON.parse(user), outputCorrection: correction })
      : user;
    try {
      raw = await input.provider.complete(
        {
          system: isCorrection
            ? `${prompt.instructions}\n\n${OUTPUT_REPAIR_PROMPT.instructions}`
            : prompt.instructions,
          user: requestUser,
          maxOutputChars: 40_000,
          onCompletion: (metadata) => {
            completion =
              metadata?.stopReason === "completed" || metadata?.stopReason === "length-limit"
                ? metadata.stopReason
                : "unknown";
          },
        },
        AbortSignal.timeout(180_000),
      );
    } catch (error) {
      rethrowCreditExhausted(error); // waits for credit; never retried or flattened (#407)
      if (
        (completion as string) === "length-limit" &&
        error instanceof ModelProviderError &&
        error.code === "bad-response"
      ) {
        raw = ""; // The adapter supplied truncation evidence, even with no usable text.
      } else {
        lastFailure = "provider-failed";
        providerError = error instanceof ModelProviderError ? error.code : "unavailable";
        // An unknown or rejected model is not retried with the same request.
        if (providerError === "bad-request" || providerError === "unauthorised") break;
        continue;
      }
    }
    let parsed: PackageModelDraft | undefined;
    let kind: DraftValidationKind | undefined;
    let issues: SafeDraftIssue[] = [];
    try {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        // Retain the existing tolerance for a JSON object wrapped in prose or
        // a code fence, without misclassifying valid JSON scalars as syntax errors.
        json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      }
      const checked = ModelDraftSchema.safeParse(json);
      if (checked.success) parsed = checked.data;
      else {
        kind = "schema-validation";
        issues = safeDraftIssues(checked.error);
      }
    } catch {
      kind = "json-syntax";
    }
    if ((completion as string) === "length-limit") kind = "truncated-output";
    if (!kind && parsed) {
      const problems = draftProblems(pkg, parsed);
      if (problems.length > 0) {
        kind = "evidence-validation";
        lastProblems = problems;
        issues = [{ code: "custom", path: ["responses"] }];
      }
    }
    if (kind) {
      validationFailure = kind;
      lastFailure = kind === "evidence-validation" ? "invalid-draft" : "malformed-output";
      diagnostics.push(
        await saveDraftDiagnostic({
          content: input.content,
          package: input.package,
          baseKey: key,
          attempt: attempt + 1,
          promptVersion: promptId,
          ...(isCorrection ? { repairPromptVersion: PACKAGE_OUTPUT_REPAIR_ID } : {}),
          modelVersion: input.provider.modelVersion,
          kind,
          issues,
          raw,
          completion,
        }),
      );
      correction = { previousOutput: raw, kind, issues };
      continue;
    }
    draft = parsed;
    repaired = isCorrection;
  }
  if (!draft) {
    return {
      status: "failed",
      reason: lastFailure,
      // The detailed validator may mention untrusted model IDs. Never return
      // those strings through CLI/status output.
      ...(lastProblems.length > 0 ? { problems: ["evidence-validation-failed"] } : {}),
      ...(lastFailure === "provider-failed" && providerError ? { providerError } : {}),
      ...(lastFailure !== "provider-failed" && validationFailure ? { validationFailure } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
    };
  }
  const markdown = renderPackageDraft(pkg, draft, sourceUrl);
  const outputBase = repaired ? repairedBase : base;
  const draftRef = await writeOnce(input.content, `${outputBase}.md`, markdown);
  const metadata = PackageDraftMetadataSchema.parse({
    schemaVersion: PACKAGE_DRAFT_SCHEMA_VERSION,
    package: toRef(input.package),
    source: pkg.source.artifact,
    themes: pkg.themeResult,
    templateVersion: PACKAGE_DRAFT_TEMPLATE_VERSION,
    promptVersion: promptId,
    ...(repaired ? { repairPromptVersion: PACKAGE_OUTPUT_REPAIR_ID } : {}),
    ...(diagnostics.length ? { diagnostics: diagnostics.map(toRef) } : {}),
    ...(input.revision
      ? {
          revisionPromptVersion: promptIdentity(
            PACKAGE_REVISION_PROMPT_VERSION,
            revisionInstructions,
          ),
        }
      : {}),
    modelVersion: input.provider.modelVersion,
    ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
    ...(input.resolvedModel?.() ? { resolvedModel: input.resolvedModel()! } : {}),
    draft: `${draftRef.commit}:${draftRef.path}`,
    fields: { title: draft.title, subtitle: draft.subtitle, excerpt: draft.excerpt },
    draftedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  const metaRef = await writeOnce(input.content, `${outputBase}.json`, metadata);
  return {
    status: "drafted",
    draft: draftRef,
    metadata: metaRef,
    reused: false,
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}
