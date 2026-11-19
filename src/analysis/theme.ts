import { z } from "zod";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import { sourceVersionFor } from "../content/fulltext-document.js";

/**
 * Source-grounded theme extraction contract.
 *
 * A theme is a recurring topic or framing a post engages with, such as
 * "surveillance" or "electromagnetic weapons". It is deliberately distinct
 * from a factual claim (an assertion that could be checked; see claim.ts) and
 * from any truth verdict: a theme says what a post is about, never whether it
 * is right. The schema has no verdict, truth or support field, and unknown
 * fields are rejected.
 *
 * Rules enforced by {@link parseThemeSet}:
 * - Every theme has at least one evidence span whose `passage` is exactly
 *   `text.slice(start, end)` of the stated source version.
 * - `label` is the normalised form of the extractor's wording (see
 *   {@link normaliseThemeLabel}); `wording` keeps that wording as given.
 * - Labels are unique within a set. New, previously unseen labels are allowed;
 *   when a known vocabulary is supplied, `novel` must say whether the label is
 *   outside it. No taxonomy service is involved.
 * - Uncertainty is preserved as `confidence` (`low`, `medium`, `high`).
 */

export const THEME_SCHEMA_VERSION = 1;
const MAX_LABEL = 60;

/**
 * Simple label normalisation: Unicode NFKC, lower case, `&` to "and",
 * punctuation other than hyphens removed, whitespace collapsed, at most six
 * words and 60 characters. Returns "" when nothing usable remains.
 */
export function normaliseThemeLabel(wording: string): string {
  const words = wording
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/-{2,}/g, "-")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .slice(0, 6);
  return words.join(" ").slice(0, MAX_LABEL).trim();
}

export const ThemeEvidenceSchema = z
  .object({
    start: z.number().int().min(0).describe("Inclusive start offset in UTF-16 code units."),
    end: z.number().int().min(1).describe("Exclusive end offset in UTF-16 code units."),
    passage: z.string().min(1).max(4000).describe("Exact source text between start and end."),
  })
  .strict()
  .meta({ title: "ThemeEvidence", description: "One exact source span supporting a theme." });

export const ThemeConfidenceSchema = z
  .enum(["low", "medium", "high"])
  .describe("How clearly the source engages with the theme. Not a judgement about truth.");

export const ThemeSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(MAX_LABEL)
      .describe("Normalised theme label: the normalised form of `wording`."),
    wording: z.string().trim().min(1).max(200).describe("The theme as the extractor worded it."),
    confidence: ThemeConfidenceSchema,
    novel: z
      .boolean()
      .optional()
      .describe("True when the label is outside a supplied known vocabulary; omitted without one."),
    evidence: z
      .array(ThemeEvidenceSchema)
      .min(1)
      .max(10)
      .describe("Source spans that show the post engaging with the theme."),
  })
  .strict()
  .meta({
    title: "Theme",
    description:
      "A topic or framing a post engages with, grounded in exact source spans. No verdict.",
  });
export type Theme = z.infer<typeof ThemeSchema>;

export const ThemeSetSchema = z
  .object({
    schemaVersion: z.literal(THEME_SCHEMA_VERSION),
    sourceVersion: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .describe("Content hash of the whole source text the themes were extracted from."),
    artifact: ArtifactReferenceSchema,
    themes: z.array(ThemeSchema).max(30),
    extraction: z
      .object({
        modelVersion: z.string().trim().min(1).max(200),
        promptVersion: z.string().trim().min(1).max(200),
        extractedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict()
  .meta({
    title: "ThemeSet",
    description: "Themes extracted from one versioned captured text, each with exact evidence.",
  });
export type ThemeSet = z.infer<typeof ThemeSetSchema>;

export interface ThemeSource {
  text: string;
  sourceVersion: string;
  artifact: ArtifactReference;
}

export class InvalidThemeError extends Error {
  constructor(reason: string) {
    // Never echo source text or model output.
    super(`Invalid theme set: ${reason}`);
    this.name = "InvalidThemeError";
  }
}

/** JSON Schema (draft 2020-12) for {@link ThemeSetSchema}. */
export function themeSetJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ThemeSetSchema) as Record<string, unknown>;
}

/**
 * Validate untrusted extracted themes against their source. Rejects missing
 * or mismatched evidence, wrong source version or artifact, unnormalised or
 * duplicate labels, an incorrect `novel` flag and unknown fields.
 */
export function parseThemeSet(
  input: unknown,
  source: ThemeSource,
  knownLabels?: ReadonlySet<string>,
): ThemeSet {
  const parsed = ThemeSetSchema.safeParse(input);
  if (!parsed.success) throw new InvalidThemeError("structure failed validation");
  const set = parsed.data;
  if (
    set.sourceVersion !== source.sourceVersion ||
    sourceVersionFor(source.text) !== set.sourceVersion
  ) {
    throw new InvalidThemeError("source version does not match the supplied source");
  }
  for (const field of ["repository", "commit", "path", "hash"] as const) {
    if (set.artifact[field] !== source.artifact[field]) {
      throw new InvalidThemeError("artifact does not match the supplied source artifact");
    }
  }
  const labels = new Set<string>();
  for (const theme of set.themes) {
    const normalised = normaliseThemeLabel(theme.wording);
    if (!normalised || theme.label !== normalised) {
      throw new InvalidThemeError("label is not the normalised form of its wording");
    }
    if (labels.has(theme.label)) throw new InvalidThemeError("duplicate theme label");
    labels.add(theme.label);
    if (knownLabels !== undefined && theme.novel !== !knownLabels.has(theme.label)) {
      throw new InvalidThemeError("novel flag does not match the known vocabulary");
    }
    if (knownLabels === undefined && theme.novel !== undefined) {
      throw new InvalidThemeError("novel flag given without a known vocabulary");
    }
    for (const evidence of theme.evidence) {
      if (evidence.end <= evidence.start || evidence.end > source.text.length) {
        throw new InvalidThemeError("evidence span lies outside the source text");
      }
      if (source.text.slice(evidence.start, evidence.end) !== evidence.passage) {
        throw new InvalidThemeError("evidence passage does not match the source text at that span");
      }
    }
  }
  return set;
}

/** Synthetic examples, valid against {@link SYNTHETIC_THEME_SOURCE_TEXT}. */
export const SYNTHETIC_THEME_SOURCE_TEXT =
  "The synthetic towers are watching everyone. Nobody voted for the new synthetic meters.";
