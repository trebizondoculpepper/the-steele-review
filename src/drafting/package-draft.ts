import {
  markdownToProseMirror,
  UnsupportedMarkdownError,
} from "../publishing/substack/prosemirror.js";
import { editorialLineageRefs, type EditorialLineage } from "../content/editorial-lineage.js";
import {
  MARKDOWN_ARTICLE_FORMAT,
  MarkdownArticleError,
  MarkdownCandidateSchema,
  splitMarkdownArticle,
  type MarkdownCandidate,
} from "./markdown-article.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadPromptFile } from "../prompt-files.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  captureWriterAttempt,
  finishWriterValidation,
  WriterAttemptError,
  type CapturedWriterAttempt,
} from "./writer-attempts.js";
import {
  safeDraftIssues,
  saveDraftDiagnostic,
  type DraftValidationKind,
  type SafeDraftIssue,
} from "./draft-diagnostics.js";
import { MechanicalPolicySchema, type MechanicalPolicy } from "./mechanical-policy.js";
import {
  metadataFieldRepair,
  fieldRepairRequest,
  mergeFieldPatch,
  type FieldRepair,
} from "./field-repair.js";
import {
  commitMergedCandidate,
  mechanicalStart,
  saveMechanicalRecord,
  mechanicalRef,
  type MechanicalRecord,
} from "./mechanical-record.js";
import { PublicationFieldsSchema } from "../content/publication-fields.js";
export { FIELD_LIMITS } from "../content/publication-fields.js";
import type { ExtractionModelProvider, ExtractionPrompt } from "../analysis/extraction.js";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import { ModelProviderError } from "../controllers/openrouter.js";
import { writeOnce } from "../research/job.js";
import { loadPinnedContext } from "./pinned-context.js";
import { promptIdentity } from "./prompt-identity.js";

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

export const PACKAGE_DRAFT_TEMPLATE_VERSION = "package-explainer-v6";
/** Bound on the previous draft text sent to the revision writer. */
export const MAX_PREVIOUS_DRAFT_CHARS = 40_000;
export const PACKAGE_DRAFT_SCHEMA_VERSION = 1;

/** Revision instructions for redrafts (#150), from their own editable Markdown file. */
const PACKAGE_REVISION_PROMPT = loadPromptFile("writer", "package-revision");
const FIELD_REPAIR_PROMPT = loadPromptFile("writer", "package-field-repair");
export const PACKAGE_FIELD_REPAIR_ID = promptIdentity(
  FIELD_REPAIR_PROMPT.version,
  FIELD_REPAIR_PROMPT.instructions,
);
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
/** The writer prompt for the Markdown article contract (#535). */
export const DEFAULT_PACKAGE_MARKDOWN_PROMPT = loadPromptFile(
  "writer",
  "package-explainer-markdown",
);
const MARKDOWN_OUTPUT_REPAIR_PROMPT = loadPromptFile("writer", "package-output-repair-markdown");
export const PACKAGE_MARKDOWN_OUTPUT_REPAIR_ID = promptIdentity(
  MARKDOWN_OUTPUT_REPAIR_PROMPT.version,
  MARKDOWN_OUTPUT_REPAIR_PROMPT.instructions,
);
/** Writer output contracts: legacy structured JSON, or Markdown with a JSON header (#535). */
export type WriterFormat = "json" | "markdown";

/**
 * The deployment's writer output contract: `STEELE_WRITER_FORMAT` is "json"
 * (default, the current behaviour) or "markdown". Anything else is refused
 * rather than silently treated as either.
 */
export function writerFormatFromEnv(
  env: Record<string, string | undefined> = process.env,
): WriterFormat {
  const value = env.STEELE_WRITER_FORMAT;
  if (value === undefined || value === "" || value === "json") return "json";
  if (value === "markdown") return "markdown";
  throw new Error("STEELE_WRITER_FORMAT must be json or markdown");
}

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
    sourceContext: Ref.optional(),
    contextVersion: z.string().optional(),
    templateVersion: z.string(),
    promptVersion: z.string(),
    /** Revision instructions identity, for redrafts only (#430). */
    revisionPromptVersion: z.string().optional(),
    repairPromptVersion: z.string().optional(),
    repairPromptVersions: z.array(z.string()).max(10).optional(),
    diagnostics: z.array(Ref).max(10).optional(),
    mechanicalRun: Ref.optional(),
    writerAttempts: z.array(Ref).max(100).optional(),
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
    /** Writer output contract (#535); absent on legacy structured-JSON drafts. */
    format: z.literal(MARKDOWN_ARTICLE_FORMAT).optional(),
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
/** The evidence-bearing parts of any draft, legacy JSON or Markdown (#535). */
export interface DraftEvidenceView {
  responses: { claimRecordId: string; verdict: string; evidence: number[] }[];
  narrative?: { status: "supported"; history: number[] } | { status: "limited" };
  widerContext?: { status: "supported"; background: number[] } | { status: "limited" };
}

export function draftProblems(pkg: WriterPackage, draft: DraftEvidenceView): string[] {
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

/**
 * Numeric citation markers a model writes into prose (#491).
 *
 * The model sees evidence indices local to one claim (`0` means that claim's
 * first item), while the rendered article has one deduplicated, one-based
 * Sources list built by application code. A model-written `[0]` therefore has
 * no deterministic meaning, so such markers are rejected as bounded draft
 * validation feedback instead of being trusted or silently deleted.
 *
 * Markdown links (`[text](url)`) are not citations and are ignored.
 */
const MODEL_CITATION = /\[(\d+(?:\s*[,;\u2013-]\s*\d+)*)\](?!\()/g;

/**
 * Every field whose text reaches readers, with the schema-owned path of each
 * model-written marker. Paths name only schema fields and array positions:
 * never claim IDs, raw marker text or other model-controlled strings.
 */
export function modelCitationIssues(draft: PackageModelDraft): SafeDraftIssue[] {
  const issues: SafeDraftIssue[] = [];
  const scan = (path: SafeDraftIssue["path"], text: string | undefined) => {
    if (text && text.search(MODEL_CITATION) >= 0) issues.push({ code: "custom", path });
    MODEL_CITATION.lastIndex = 0;
  };
  scan(["title"], draft.title);
  scan(["subtitle"], draft.subtitle);
  scan(["excerpt"], draft.excerpt);
  scan(["summary"], draft.summary);
  draft.responses.forEach((r, i) => scan(["responses", i, "text"], r.text));
  if (draft.narrative) {
    draft.narrative.status === "supported"
      ? scan(["narrative", "text"], draft.narrative.text)
      : scan(["narrative", "limitation"], draft.narrative.limitation);
  }
  if (draft.widerContext) {
    draft.widerContext.status === "supported"
      ? scan(["widerContext", "text"], draft.widerContext.text)
      : scan(["widerContext", "limitation"], draft.widerContext.limitation);
  }
  draft.limitations.forEach((l, i) => scan(["limitations", i], l));
  return issues;
}

/** Human-readable problems for the bounded correction feedback (paths only). */
export function modelCitationProblems(draft: PackageModelDraft): string[] {
  return modelCitationIssues(draft).map(
    (i) =>
      `${i.path.join(".")} contains a model-written citation marker; final references are rendered by the application`,
  );
}

/** Evidence view of a Markdown candidate: its provenance, in the legacy shape. */
export function markdownEvidenceView(c: MarkdownCandidate): DraftEvidenceView {
  const { narrativeHistory, widerContextBackground } = c.provenance;
  return {
    responses: c.provenance.responses,
    ...(narrativeHistory?.length
      ? { narrative: { status: "supported" as const, history: narrativeHistory } }
      : {}),
    ...(widerContextBackground?.length
      ? { widerContext: { status: "supported" as const, background: widerContextBackground } }
      : {}),
  };
}

/** Model-written citation markers in a Markdown candidate's header text and body. */
export function markdownCitationIssues(c: MarkdownCandidate): SafeDraftIssue[] {
  const issues: SafeDraftIssue[] = [];
  for (const [name, text] of [
    ["title", c.title],
    ["subtitle", c.subtitle],
    ["excerpt", c.excerpt],
    ["body", c.body],
  ] as const) {
    if (text.search(MODEL_CITATION) >= 0) issues.push({ code: "custom", path: [name] });
    MODEL_CITATION.lastIndex = 0;
  }
  return issues;
}

/** Human-readable marker problems from issue paths only. */
export function citationProblems(issues: SafeDraftIssue[]): string[] {
  return issues.map(
    (i) =>
      `${i.path.join(".")} contains a model-written citation marker; final references are rendered by the application`,
  );
}

/** The candidate as the Markdown text the writer is shown for a correction. */
function markdownCandidateText(candidate: unknown): string {
  const { body, ...header } = (candidate ?? {}) as Record<string, unknown>;
  return `---json\n${JSON.stringify(header)}\n---\n\n${typeof body === "string" ? body : ""}`;
}

/**
 * Render a Markdown article (#535): the writer's body exactly, framed by the
 * application-owned parts the legacy renderer also produced. Claim verdict
 * markers come from provenance, earlier passages are quoted from the package,
 * and the numbered Sources list is built from the cited evidence indices, so
 * deterministic verification reads the same contract as before.
 */
export function renderMarkdownDraft(
  pkg: WriterPackage,
  c: MarkdownCandidate,
  sourceUrl: string,
): string {
  const linkText = (pkg.source.title ?? sourceUrl).replace(/[\\[\]]/g, (ch) => `\\${ch}`);
  const claims = new Map(pkg.claims.map((claim) => [claim.claimRecordId, claim]));
  const sources: { url: string; passage: string; archived?: string }[] = [];
  const seen = new Set<string>();
  const cite = (url: string, passage: string, archived?: string) => {
    const key = JSON.stringify([url, passage]);
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ url, passage, ...(archived ? { archived } : {}) });
  };
  const lines: string[] = [];
  for (const r of c.provenance.responses) {
    lines.push(
      `<!-- claim-verdict ${Buffer.from(r.claimRecordId).toString("hex")} ${r.verdict} -->`,
    );
    const claim = claims.get(r.claimRecordId)!;
    for (const i of r.evidence) {
      const e = claim.evidence[i]!;
      cite(
        e.url,
        e.passage,
        e.archived ? `${e.archived.commit.slice(0, 12)}:${e.archived.path}` : undefined,
      );
    }
  }
  if (lines.length > 0) lines.push("");
  lines.push(c.body.trimEnd(), "");
  const omitNarrative =
    pkg.context?.history.status === "gap" && pkg.context.history.omitWhenAbsent === true;
  const comparisons = pkg.context?.history.comparisons ?? [];
  if (!omitNarrative && c.provenance.narrativeHistory?.length) {
    for (const i of c.provenance.narrativeHistory) {
      const cmp = comparisons[i]!;
      for (const e of cmp.earlier) {
        lines.push(`> "${e.quote}" (${e.publishedAt}${e.url ? `, ${e.url}` : ""})`, "");
      }
      lines.push(
        `_Comparison (${cmp.kind}, ${cmp.uncertainty} uncertainty; analysis, not evidence): ${cmp.comparison.text}_`,
        "",
      );
      if (cmp.conflictRationale) lines.push(`_Qualification: ${cmp.conflictRationale}_`, "");
      if (cmp.changedCircumstances)
        lines.push(`_Changed circumstances: ${cmp.changedCircumstances}_`, "");
    }
  }
  const passages = pkg.context?.background.passages ?? [];
  for (const i of c.provenance.widerContextBackground ?? []) {
    cite(passages[i]!.url, passages[i]!.passage);
  }
  lines.push("## Sources", "", `Original post: [${linkText}](<${sourceUrl}>)`, "");
  if (sources.length > 0) {
    lines.push(
      ...sources.map(
        (src, i) =>
          `${i + 1}. ${src.url}${src.archived ? ` (archived ${src.archived})` : ""}: "${src.passage}"`,
      ),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** True when every marker sits in an isolated publication-metadata field. */
const METADATA_PATHS = new Set(["title", "subtitle", "excerpt"]);
export function metadataOnlyMarkers(issues: SafeDraftIssue[]): boolean {
  return (
    issues.length > 0 &&
    issues.every((i) => i.path.length === 1 && METADATA_PATHS.has(String(i.path[0])))
  );
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

/** Retain a partial mechanical run without mislabelling a domain guard as a provider failure. */
export class DraftGuardStop extends Error {
  constructor(
    readonly failure: unknown,
    readonly retention: {
      mechanicalRun?: ArtifactRef;
      retainedAttempts: ArtifactRef[];
      diagnostics: ArtifactRef[];
    },
  ) {
    super("writer domain guard stopped");
  }
}
/** Same operational credit category, with the already-durable attempt references. */
export class DraftCreditStop extends ModelProviderError {
  constructor(
    readonly mechanicalRun: ArtifactRef,
    readonly writerAttempts: ArtifactRef[],
    readonly diagnostics: ArtifactRef[],
  ) {
    super("credit-exhausted");
  }
}

export type PackageDraftOutcome =
  | {
      status: "drafted";
      draft: ArtifactRef;
      metadata: ArtifactRef;
      reused: boolean;
      diagnostics?: ArtifactRef[];
      writerAttempts?: ArtifactRef[];
      retention?: "recorded" | "legacy-unavailable";
      mechanicalRun?: ArtifactRef;
    }
  | { status: "evidence-gap" }
  | { status: "context-unavailable"; reason: string }
  | {
      status: "failed";
      reason:
        | "provider-failed"
        | "malformed-output"
        | "invalid-draft"
        | "application-format-failed"
        | "writer-archive-failed"
        | "writer-attempt-busy"
        | "writer-attempt-interrupted"
        | "mechanical-deadline-exhausted"
        /** The caller's link differs from the package's pinned original URL (#276). */
        | "source-url-mismatch"
        /** Neither the package nor the caller supplies the original post's link. */
        | "no-source-url";
      problems?: string[];
      /** Sanitised provider error code, e.g. "bad-request" for an unknown model. */
      providerError?: string;
      validationFailure?: DraftValidationKind;
      diagnostics?: ArtifactRef[];
      writerAttempts?: ArtifactRef[];
      mechanicalRun?: ArtifactRef;
    };

export async function draftFromPackage(input: {
  content: GitArtifactStore;
  operations: OperationStore;
  writerRecoveryId?: string;
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
  /** Legacy override of total mechanical turns; default is three, never extra retries. */
  maxAttempts?: number;
  mechanicalPolicy?: Partial<MechanicalPolicy>;
  /**
   * Verifier feedback for a redraft (#150): the passages and reasons to fix.
   * Part of the draft's identity, so each revision is a new, separately saved draft.
   */
  revision?: {
    number: number;
    feedback: { passage: string; reason: string }[];
    /**
     * The verifier's minor issues from the same report (#576): context only.
     * They never block approval and the writer is told so; they let an
     * already-required redraft avoid leaving a known weakness in place.
     */
    observations?: { passage: string; reason: string }[];
  };
  /**
   * The exact immediately preceding saved draft (#489). The writer revises
   * that article; it is not asked to regenerate from feedback alone. Its
   * reference is part of this draft's identity.
   */
  previousDraft?: {
    ref: ArtifactRef;
    markdown: string;
    /** The previous draft's generated publication fields, from its saved metadata. */
    fields?: { title: string; subtitle: string; excerpt: string };
    /** The saved metadata the fields were read from; part of the identity. */
    metadataRef?: ArtifactRef;
  };
  /** Exact saved inputs behind editorial feedback; not model-generated references. */
  revisionInputs?: ArtifactRef[];
  /** Explicit continuation only; absent preserves all legacy generation identities. */
  lineage?: EditorialLineage;
  /** Domain guard outside provider execution, after completed-generation reuse. */
  beforeNewGeneration?: () => Promise<void>;
  /** Revision instructions; defaults to the editable package-revision.md. */
  revisionInstructions?: string;
  /**
   * Writer output contract (#535). "json" (default) keeps the legacy
   * structured draft; "markdown" asks for a Markdown body with a JSON header.
   */
  format?: WriterFormat;
  now?: () => Date;
}): Promise<PackageDraftOutcome> {
  const markdown = (input.format ?? writerFormatFromEnv()) === "markdown";
  const prompt =
    input.prompt ?? (markdown ? DEFAULT_PACKAGE_MARKDOWN_PROMPT : DEFAULT_PACKAGE_DRAFT_PROMPT);
  // The repair instructions follow the output contract (#535).
  const outputRepairId = markdown ? PACKAGE_MARKDOWN_OUTPUT_REPAIR_ID : PACKAGE_OUTPUT_REPAIR_ID;
  const outputRepairInstructions = markdown
    ? MARKDOWN_OUTPUT_REPAIR_PROMPT.instructions
    : OUTPUT_REPAIR_PROMPT.instructions;
  const pkg = WriterPackageSchema.parse(JSON.parse(await input.content.read(input.package)));
  // Coverage is information for the writer, not a veto (#747): a valid
  // package with zero, partial or full claim support is drafted. Its
  // uncovered claims keep their own statuses and cannot be cited.
  const pinnedUrl = pkg.source.originalUrl;
  if (pinnedUrl && input.sourceUrl && input.sourceUrl !== pinnedUrl)
    return { status: "failed", reason: "source-url-mismatch" };
  const sourceUrl = pinnedUrl ?? input.sourceUrl;
  if (!sourceUrl) return { status: "failed", reason: "no-source-url" };

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
    ...(pkg.source.context ? { sourceContext: toArtifactRef(pkg.source.context) } : {}),
  });
  if (loaded.kind !== "loaded") return { status: "context-unavailable", reason: loaded.kind };

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
        loaded.context.contextRef,
        ...(input.revision
          ? [
              input.revision,
              promptIdentity(PACKAGE_REVISION_PROMPT_VERSION, revisionInstructions),
              ...(input.previousDraft ? [toRef(input.previousDraft.ref)] : []),
              ...(input.previousDraft?.metadataRef ? [toRef(input.previousDraft.metadataRef)] : []),
            ]
          : []),
        ...(input.lineage ? [editorialLineageRefs(input.lineage).map(toRef)] : []),
        // A package without a pinned URL takes it from the caller: part of the identity.
        ...(pinnedUrl ? [] : [sourceUrl]),
        // The output contract is part of identity; legacy keys are unchanged.
        ...(markdown ? [MARKDOWN_ARTICLE_FORMAT] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const base = `articles/${pkg.post.publicationId}/${pkg.post.postId}/${key}`;
  const repairedKey = createHash("sha256")
    .update(JSON.stringify([key, outputRepairId, PACKAGE_FIELD_REPAIR_ID, "mechanical-v1"]))
    .digest("hex")
    .slice(0, 32);
  const repairedBase = `articles/${pkg.post.publicationId}/${pkg.post.postId}/${repairedKey}`;
  const legacyRepairedKey = createHash("sha256")
    .update(JSON.stringify([key, PACKAGE_OUTPUT_REPAIR_ID]))
    .digest("hex")
    .slice(0, 32);
  const legacyRepairedBase = `articles/${pkg.post.publicationId}/${pkg.post.postId}/${legacyRepairedKey}`;
  // Existing accepted legacy drafts remain usable; absence of raw output is explicit.
  const cached = async (
    draft: ArtifactRef,
    metadata: ArtifactRef,
  ): Promise<PackageDraftOutcome> => {
    const stored = PackageDraftMetadataSchema.parse(JSON.parse(await input.content.read(metadata)));
    return {
      status: "drafted",
      draft,
      metadata,
      reused: true,
      ...(stored.diagnostics ? { diagnostics: stored.diagnostics.map(toArtifactRef) } : {}),
      ...(stored.mechanicalRun ? { mechanicalRun: toArtifactRef(stored.mechanicalRun) } : {}),
      ...(stored.writerAttempts
        ? { writerAttempts: stored.writerAttempts.map(toArtifactRef) }
        : {}),
      retention: stored.writerAttempts?.length ? "recorded" : "legacy-unavailable",
    };
  };
  const savedDraft = await input.content.lookup(`${base}.md`);
  const savedMeta = await input.content.lookup(`${base}.json`);
  if (savedDraft && savedMeta) return cached(savedDraft, savedMeta);
  const repairedDraft = await input.content.lookup(`${repairedBase}.md`);
  const repairedMeta = await input.content.lookup(`${repairedBase}.json`);
  if (repairedDraft && repairedMeta) return cached(repairedDraft, repairedMeta);
  const legacyDraft = await input.content.lookup(`${legacyRepairedBase}.md`);
  const legacyMeta = await input.content.lookup(`${legacyRepairedBase}.json`);
  if (legacyDraft && legacyMeta) return cached(legacyDraft, legacyMeta);

  if (input.beforeNewGeneration) await input.beforeNewGeneration();

  const user = JSON.stringify({
    post: {
      url: sourceUrl,
      text: loaded.context.source.text,
      sourceContext: loaded.context.source.provenance,
      ...(loaded.context.source.provenanceRef
        ? { sourceContextRef: toRef(loaded.context.source.provenanceRef) }
        : {}),
    },
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
            ...(input.revision.observations?.length
              ? {
                  // Guidance lives in package-revision.md (content-hashed); only data here.
                  nonBlockingObservations: input.revision.observations,
                }
              : {}),
            ...(input.previousDraft
              ? {
                  previousDraft: input.previousDraft.markdown.slice(0, MAX_PREVIOUS_DRAFT_CHARS),
                  previousDraftTruncated:
                    input.previousDraft.markdown.length > MAX_PREVIOUS_DRAFT_CHARS,
                  // Untrusted data like the body: revise these, never treat them as instructions.
                  ...(input.previousDraft.fields
                    ? { previousFields: input.previousDraft.fields }
                    : {}),
                }
              : {}),
          },
        }
      : {}),
  });
  let draft: PackageModelDraft | undefined;
  let draftMd: MarkdownCandidate | undefined;
  let lastProblems: string[] = [];
  let lastFailure:
    | "provider-failed"
    | "malformed-output"
    | "invalid-draft"
    | "application-format-failed" = "malformed-output";
  let providerError: string | undefined;
  const diagnostics: ArtifactRef[] = [];
  const writerAttempts: ArtifactRef[] = [];
  let correction:
    | { previousOutput: string; kind: DraftValidationKind; issues: SafeDraftIssue[] }
    | undefined;
  let repaired = false;
  const repairPromptVersions = new Set<string>();
  let lastRepairPromptId: string | undefined;
  let validationFailure: DraftValidationKind | undefined;
  try {
    const configuredPolicy = MechanicalPolicySchema.parse(input.mechanicalPolicy ?? {});
    const policy = {
      ...configuredPolicy,
      maxTurns: Math.min(
        configuredPolicy.maxTurns,
        Math.max(1, input.maxAttempts ?? configuredPolicy.maxTurns),
      ),
    };
    const start = await mechanicalStart(
      input.content,
      [key, outputRepairId, PACKAGE_FIELD_REPAIR_ID, input.writerRecoveryId ?? null],
      policy,
    );
    const deadline = start.deadlineAt;
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const mechanical: MechanicalRecord = {
      schemaVersion: 1,
      package: mechanicalRef(input.package),
      start: mechanicalRef(start.ref),
      policy,
      outcome: "in-progress",
      turns: [],
    };
    let mechanicalRun: ArtifactRef | undefined;
    let fieldRepair: FieldRepair | undefined;
    let previousCandidateRef: ArtifactRef | undefined;
    const attempts = policy.maxTurns;
    for (let attempt = 0; attempt < attempts && !draft && !draftMd; attempt++) {
      if (Date.now() >= deadline || signal.aborted) {
        mechanical.outcome = "deadline-exhausted";
        mechanicalRun = await saveMechanicalRecord(input.content, mechanical);
        return {
          status: "failed",
          reason: "mechanical-deadline-exhausted",
          mechanicalRun,
          writerAttempts,
          diagnostics,
        };
      }
      let raw: string;
      let completion: "completed" | "length-limit" | "unknown" = "unknown";
      const isCorrection = correction !== undefined;
      const mode = fieldRepair
        ? "metadata-fields"
        : !isCorrection
          ? "initial"
          : correction?.kind === "evidence-validation"
            ? "evidence"
            : "format-schema";
      const repairPromptId = fieldRepair ? PACKAGE_FIELD_REPAIR_ID : outputRepairId;
      if (isCorrection) {
        repairPromptVersions.add(repairPromptId);
        lastRepairPromptId = repairPromptId;
      }
      const requestUser = fieldRepair
        ? JSON.stringify(fieldRepairRequest(fieldRepair))
        : correction
          ? JSON.stringify({ ...JSON.parse(user), outputCorrection: correction })
          : user;
      if (input.beforeNewGeneration) {
        try {
          await input.beforeNewGeneration();
        } catch (error) {
          throw new DraftGuardStop(error, {
            ...(mechanical.turns.length
              ? { mechanicalRun: await saveMechanicalRecord(input.content, mechanical) }
              : {}),
            retainedAttempts: writerAttempts,
            diagnostics,
          });
        }
      }
      let captured: CapturedWriterAttempt;
      try {
        captured = await captureWriterAttempt({
          content: input.content,
          operations: input.operations,
          provider: input.provider,
          request: {
            system: fieldRepair
              ? FIELD_REPAIR_PROMPT.instructions
              : isCorrection
                ? `${prompt.instructions}\n\n${outputRepairInstructions}`
                : prompt.instructions,
            user: requestUser,
            maxOutputChars: 40_000,
          },
          package: input.package,
          source: pkg.source.artifact,
          context: [
            ...(pkg.source.context ? [pkg.source.context] : []),
            pkg.coverage,
            pkg.themeResult,
            pkg.claimResult,
            ...(input.previousDraft ? [toRef(input.previousDraft.ref)] : []),
            ...(input.revisionInputs ?? []).map(toRef),
          ],
          kind: isCorrection ? "correction" : input.revision ? "revision" : "initial",
          number: attempt + 1,
          ...(input.revision ? { revision: input.revision.number } : {}),
          promptVersion: promptId,
          ...(isCorrection ? { repairPromptVersion: repairPromptId } : {}),
          ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
          signal,
          leaseMs: Math.max(10 * 60_000, policy.deadlineMs + 60_000),
          ...(input.writerRecoveryId ? { recoveryId: input.writerRecoveryId } : {}),
        });
      } catch (error) {
        if (error instanceof WriterAttemptError)
          return {
            status: "failed",
            reason:
              error.code === "archive-failed"
                ? "writer-archive-failed"
                : error.code === "busy"
                  ? "writer-attempt-busy"
                  : "writer-attempt-interrupted",
            ...(writerAttempts.length ? { writerAttempts } : {}),
            ...(diagnostics.length ? { diagnostics } : {}),
          };
        throw error;
      }
      if (captured.manifest.outcome === "interrupted")
        return {
          status: "failed",
          reason: "writer-attempt-interrupted",
          writerAttempts: [...writerAttempts, captured.ref],
        };
      const turn: MechanicalRecord["turns"][number] = {
        number: attempt + 1,
        mode,
        attempt: mechanicalRef(captured.ref),
      };
      mechanical.turns.push(turn);
      if (Date.now() >= deadline || signal.aborted) {
        mechanical.outcome = "deadline-exhausted";
        mechanicalRun = await saveMechanicalRecord(input.content, mechanical);
        return {
          status: "failed",
          reason: "mechanical-deadline-exhausted",
          mechanicalRun,
          writerAttempts: [...writerAttempts, captured.ref],
          diagnostics,
        };
      }
      completion = captured.manifest.completion.stopReason;
      if (
        captured.text === undefined ||
        (captured.manifest.failure && captured.manifest.failure !== "bad-response")
      ) {
        writerAttempts.push(
          await finishWriterValidation({
            content: input.content,
            attempt: captured,
            accepted: false,
          }),
        );
        providerError = captured.manifest.failure ?? "unavailable";
        lastFailure = "provider-failed";
        mechanical.outcome = "provider-failed";
        mechanicalRun = await saveMechanicalRecord(input.content, mechanical);
        if (providerError === "credit-exhausted")
          throw new DraftCreditStop(mechanicalRun, writerAttempts, diagnostics);
        // Correction turns require an actual retained response, never an
        // ambiguous transport failure or an automatic provider retry.
        break;
      }
      raw = captured.text;
      let parsed: PackageModelDraft | undefined;
      let parsedMd: MarkdownCandidate | undefined;
      // A body the publisher cannot render needs a whole-article correction.
      let undeliverableBody = false;
      let candidate: unknown;
      let candidateRef: ArtifactRef | undefined;
      let kind: DraftValidationKind | undefined;
      let issues: SafeDraftIssue[] = [];
      try {
        let json: unknown;
        if (markdown && !fieldRepair) {
          // Structural split only; the candidate schema validates the fields.
          const split = splitMarkdownArticle(raw);
          json = {
            ...(split.header && typeof split.header === "object" && !Array.isArray(split.header)
              ? (split.header as Record<string, unknown>)
              : {}),
            body: split.body,
          };
        } else
          try {
            json = JSON.parse(raw);
          } catch {
            // Retain the existing tolerance for a JSON object wrapped in prose or
            // a code fence, without misclassifying valid JSON scalars as syntax errors.
            json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
          }
        if (fieldRepair) {
          const merged = mergeFieldPatch(fieldRepair, json);
          if (!merged) {
            kind = "schema-validation";
            issues = fieldRepair.fields.map((name) => ({ code: "custom", path: [name] }));
          } else {
            candidateRef = await commitMergedCandidate(input.content, merged, [
              previousCandidateRef!,
              captured.ref,
            ]);
            turn.candidate = mechanicalRef(candidateRef);
            json = merged;
          }
        }
        candidate = json;
        if (markdown) {
          const checked = kind ? undefined : MarkdownCandidateSchema.safeParse(json);
          if (checked?.success) parsedMd = checked.data;
          else if (checked) {
            kind = "schema-validation";
            issues = safeDraftIssues(checked.error);
          }
        } else {
          const checked = kind ? undefined : ModelDraftSchema.safeParse(json);
          if (checked?.success) parsed = checked.data;
          else if (checked) {
            kind = "schema-validation";
            issues = safeDraftIssues(checked.error);
          }
        }
      } catch (error) {
        // A malformed Markdown header is the Markdown contract's syntax error.
        if (error instanceof SyntaxError || error instanceof MarkdownArticleError)
          kind = "json-syntax";
        else throw error;
      }
      if ((completion as string) === "length-limit") kind = "truncated-output";
      if (!kind && (parsed || parsedMd)) {
        const structural = draftProblems(pkg, parsed ?? markdownEvidenceView(parsedMd!));
        const markers = parsed ? modelCitationIssues(parsed) : markdownCitationIssues(parsedMd!);
        if (structural.length === 0 && metadataOnlyMarkers(markers)) {
          // Markers only in isolated metadata fields: repair just those fields
          // (#549's field-only path), preserving body and citation data.
          kind = "schema-validation";
          lastProblems = citationProblems(markers);
          issues = markers.slice(0, 30);
        } else if (structural.length > 0 || markers.length > 0) {
          kind = "evidence-validation";
          lastProblems = [...structural, ...citationProblems(markers)];
          // Exact schema paths for markers; structural evidence problems stay
          // attributed to the responses array.
          issues = [
            ...(structural.length > 0
              ? [{ code: "custom" as const, path: ["responses" as const] }]
              : []),
            ...markers,
          ].slice(0, 30); // the diagnostic contract records at most 30 issues
        }
      }
      // Only after the evidence checks pass (rendering needs valid indices).
      // Check the model-owned body separately from application-owned framing.
      // A writer cannot repair immutable evidence appended by the application.
      if (!kind && parsedMd) {
        try {
          markdownToProseMirror(parsedMd.body);
        } catch (error) {
          if (!(error instanceof UnsupportedMarkdownError)) throw error;
          undeliverableBody = true;
          kind = "schema-validation";
          issues = [{ code: "custom", path: ["body"] }];
          lastProblems = [`body uses Markdown the publisher cannot render (${error.reason})`];
        }
        if (!kind) {
          try {
            markdownToProseMirror(renderMarkdownDraft(pkg, parsedMd, sourceUrl));
          } catch (error) {
            if (!(error instanceof UnsupportedMarkdownError)) throw error;
            kind = "application-format";
            issues = [{ code: "custom", path: [] }];
            lastProblems = ["application-owned article framing cannot be rendered"];
          }
        }
      }
      if (kind) {
        validationFailure = kind;
        lastFailure =
          kind === "application-format"
            ? "application-format-failed"
            : kind === "evidence-validation"
              ? "invalid-draft"
              : "malformed-output";
        diagnostics.push(
          await saveDraftDiagnostic({
            content: input.content,
            package: input.package,
            baseKey: key,
            attempt: attempt + 1,
            promptVersion: promptId,
            ...(isCorrection ? { repairPromptVersion: repairPromptId } : {}),
            modelVersion: input.provider.modelVersion,
            kind,
            issues,
            raw,
            completion,
            writerAttempt: captured.ref,
          }),
        );
        writerAttempts.push(
          await finishWriterValidation({
            content: input.content,
            attempt: captured,
            accepted: false,
            diagnostic: diagnostics.at(-1),
          }),
        );
        turn.diagnostic = mechanicalRef(diagnostics.at(-1)!);
        if (kind === "application-format") {
          mechanical.outcome = "application-format-failed";
          // Keep the response and failure inspectable, but never ask the model
          // to change supported prose to compensate for application formatting.
          break;
        }
        const nextFieldRepair =
          kind === "schema-validation" && (!fieldRepair || candidateRef)
            ? metadataFieldRepair(candidate, issues)
            : undefined;
        if (fieldRepair && kind !== "evidence-validation" && !undeliverableBody) {
          // A malformed, truncated or overbroad patch cannot replace preserved fields.
          fieldRepair = nextFieldRepair ?? {
            ...fieldRepair,
            issues: issues.length ? issues : fieldRepair.issues,
          };
          if (nextFieldRepair && candidateRef) previousCandidateRef = candidateRef;
        } else {
          fieldRepair = nextFieldRepair;
          previousCandidateRef = candidateRef ?? captured.ref;
        }
        correction = {
          previousOutput: candidateRef
            ? markdown
              ? markdownCandidateText(candidate)
              : JSON.stringify(candidate)
            : raw,
          kind,
          issues,
        };
        mechanicalRun = await saveMechanicalRecord(input.content, mechanical);
        continue;
      }
      writerAttempts.push(
        await finishWriterValidation({ content: input.content, attempt: captured, accepted: true }),
      );
      mechanical.outcome = "valid";
      mechanicalRun = await saveMechanicalRecord(input.content, mechanical);
      draft = parsed;
      draftMd = parsedMd;
      repaired = isCorrection;
    }
    if (!draft && !draftMd) {
      if (mechanical.outcome === "in-progress") mechanical.outcome = "turns-exhausted";
      mechanicalRun = await saveMechanicalRecord(input.content, mechanical);
      return {
        mechanicalRun,
        status: "failed",
        reason: lastFailure,
        // The detailed validator may mention untrusted model IDs. Never return
        // those strings through CLI/status output.
        ...(lastProblems.length > 0
          ? {
              problems: [
                lastFailure === "application-format-failed"
                  ? "application-format-failed"
                  : "evidence-validation-failed",
              ],
            }
          : {}),
        ...(lastFailure === "provider-failed" && providerError ? { providerError } : {}),
        ...(lastFailure !== "provider-failed" && validationFailure ? { validationFailure } : {}),
        ...(diagnostics.length ? { diagnostics } : {}),
        ...(writerAttempts.length ? { writerAttempts } : {}),
      };
    }
    const rendered = draftMd
      ? renderMarkdownDraft(pkg, draftMd, sourceUrl)
      : renderPackageDraft(pkg, draft!, sourceUrl);
    const fields = draftMd ?? draft!;
    const outputBase = repaired ? repairedBase : base;
    const draftRef = await writeOnce(input.content, `${outputBase}.md`, rendered);
    const metadata = PackageDraftMetadataSchema.parse({
      schemaVersion: PACKAGE_DRAFT_SCHEMA_VERSION,
      package: toRef(input.package),
      source: pkg.source.artifact,
      themes: pkg.themeResult,
      ...(pkg.source.context ? { sourceContext: pkg.source.context } : {}),
      contextVersion: loaded.context.contextRef,
      templateVersion: PACKAGE_DRAFT_TEMPLATE_VERSION,
      promptVersion: promptId,
      ...(repaired
        ? {
            repairPromptVersion: lastRepairPromptId,
            repairPromptVersions: [...repairPromptVersions],
          }
        : {}),
      ...(diagnostics.length ? { diagnostics: diagnostics.map(toRef) } : {}),
      writerAttempts: writerAttempts.map(toRef),
      ...(mechanicalRun ? { mechanicalRun: toRef(mechanicalRun) } : {}),
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
      fields: { title: fields.title, subtitle: fields.subtitle, excerpt: fields.excerpt },
      ...(draftMd ? { format: MARKDOWN_ARTICLE_FORMAT } : {}),
      draftedAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    const metaRef = await writeOnce(input.content, `${outputBase}.json`, metadata);
    return {
      status: "drafted",
      draft: draftRef,
      metadata: metaRef,
      reused: false,
      ...(diagnostics.length ? { diagnostics } : {}),
      writerAttempts,
      retention: "recorded",
      ...(mechanicalRun ? { mechanicalRun } : {}),
    };
  } catch (error) {
    if (error instanceof ArtifactStoreError || error instanceof WriterAttemptError)
      return {
        status: "failed",
        reason: "writer-archive-failed",
        writerAttempts,
        diagnostics,
      };
    throw error;
  }
}
