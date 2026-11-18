import { z } from "zod";
import { ArtifactReferenceSchema, type ArtifactReference } from "../content/artifact-reference.js";
import { sourceVersionFor } from "../content/fulltext-document.js";

/**
 * Source-grounded claim extraction contract.
 *
 * Extraction produces structured claims, never verdicts. Each claim quotes one
 * exact passage of one versioned source and records where that passage sits, so
 * a later stage can re-read the same bytes and check the quote. Truth,
 * plausibility and support are deliberately absent: they belong to research and
 * verification, which run against a stored claim.
 *
 * Grounding rules enforced here:
 * - `span` is `[start, end)` in UTF-16 code units of the source text, and
 *   `passage` must equal `text.slice(start, end)` exactly. A fabricated quote or
 *   a span that points somewhere else is rejected.
 * - `sourceVersion` must equal the hash of the source text, so a claim cannot be
 *   attached to a version it was not extracted from.
 * - The model and prompt versions that produced the claim are recorded, so a
 *   deliberate re-extraction is distinguishable from an untracked change.
 * - Verbatim annotations are grounded too: every qualifier and every date
 *   wording must occur in the quoted passage, so a genuine quote cannot carry
 *   an invented precise date or hedge.
 * - The ID is derived from the validated, normalised fields and is rejected if
 *   a supplied ID does not match them, so identity cannot be forged or stale.
 * - The archive reference is supplied by trusted context, not by the model, and
 *   a claim whose artifact differs from the source artifact is rejected.
 * - Qualifiers are preserved as written. Vague dates (`"last spring"`) stay as
 *   their exact wording; `value` is present only when that wording is itself
 *   unambiguous and the value matches it.
 *
 * The schema is strict: an unknown field such as `verdict` fails validation
 * rather than being silently carried through.
 */

export const CLAIM_SCHEMA_VERSION = 1;

const SourceVersionSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .describe("Content hash of the whole source text the claim was extracted from.");

const MAX_STATEMENT = 2000;

export const ClaimTypeSchema = z
  .enum(["factual", "opinion", "prediction", "ambiguous"])
  .describe(
    "How the passage asserts: a factual claim, an opinion, a prediction, or a statement whose force is unclear. This is not a judgement about truth.",
  );
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const ClaimSpanSchema = z
  .object({
    start: z.number().int().min(0).describe("Inclusive start offset in UTF-16 code units."),
    end: z.number().int().min(1).describe("Exclusive end offset in UTF-16 code units."),
  })
  .strict()
  .meta({ title: "ClaimSpan", description: "Half-open character span within the source text." });

export type ClaimSpan = z.infer<typeof ClaimSpanSchema>;

export const DateMentionSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe(
        "Exact date wording from the passage, including any vagueness such as 'last spring'.",
      ),
    value: z.iso
      .date()
      .optional()
      .describe(
        "Calendar date, only when `text` itself is unambiguous (ISO 8601, or a day and named month with a year) and matches it. Omitted otherwise.",
      ),
  })
  .strict()
  .meta({
    title: "DateMention",
    description: "A date as the source words it, with a normalised value only when unambiguous.",
  });

export type DateMention = z.infer<typeof DateMentionSchema>;

export const ClaimExtractionMetaSchema = z
  .object({
    modelVersion: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Provider and model identifier used for extraction."),
    promptVersion: z.string().trim().min(1).max(200).describe("Version of the extraction prompt."),
    extractedAt: z.iso
      .datetime({ offset: true })
      .describe("When the claim was extracted, in ISO 8601 with offset."),
  })
  .strict()
  .meta({ title: "ClaimExtractionMeta", description: "Provenance of the extraction run." });

export type ClaimExtractionMeta = z.infer<typeof ClaimExtractionMetaSchema>;

export const ClaimSchema = z
  .object({
    schemaVersion: z.literal(CLAIM_SCHEMA_VERSION).describe("Version of this claim contract."),
    id: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .describe("Stable claim ID derived from source version, span, statement and extractor."),
    statement: z
      .string()
      .trim()
      .min(1)
      .max(MAX_STATEMENT)
      .describe("Normalised claim statement, written as the source asserts it."),
    claimType: ClaimTypeSchema,
    sourceVersion: SourceVersionSchema,
    artifact: ArtifactReferenceSchema,
    span: ClaimSpanSchema,
    passage: z
      .string()
      .min(1)
      .describe(
        "Exact source passage: must equal the source text between span.start and span.end.",
      ),
    qualifiers: z
      .array(z.string().trim().min(1).max(200))
      .max(20)
      .describe("Hedging and scope wording preserved from the passage, in order of appearance."),
    entities: z
      .array(z.string().trim().min(1).max(200))
      .max(50)
      .describe(
        "People, organisations, places or things the claim concerns, as named or referred to in the passage.",
      ),
    dates: z.array(DateMentionSchema).max(20).describe("Dates the passage mentions, in order."),
    extraction: ClaimExtractionMetaSchema,
  })
  .strict()
  .meta({
    title: "Claim",
    description:
      "One source-grounded claim: exact passage, location, type and qualifiers. Records no truth verdict.",
  });

export type Claim = z.infer<typeof ClaimSchema>;

/** A claim without its derived ID: what an extractor is allowed to supply. */
const ClaimBodySchema = ClaimSchema.omit({ id: true });

/** What a claim is checked against: one versioned source text and its archive. */
export interface ClaimSource {
  text: string;
  sourceVersion: string;
  /** Trusted archive reference for this source version. */
  artifact: ArtifactReference;
}

export class InvalidClaimError extends Error {
  constructor(reason: string) {
    // Never echo source text or model output: the caller logs this message.
    super(`Invalid claim: ${reason}`);
    this.name = "InvalidClaimError";
  }
}

/** JSON Schema (draft 2020-12) for {@link ClaimSchema}. */
export function claimJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ClaimSchema) as Record<string, unknown>;
}

/**
 * Stable claim ID. Derived from the source version, span, normalised statement
 * and extractor versions, so re-extracting identically is idempotent while a
 * changed statement, span or extractor produces a new ID.
 */
export function claimIdFor(input: {
  sourceVersion: string;
  start: number;
  end: number;
  statement: string;
  modelVersion: string;
  promptVersion: string;
}): string {
  const { sourceVersion, start, end, statement, modelVersion, promptVersion } = input;
  return sourceVersionFor(
    `${sourceVersion}\u0000${start}\u0000${end}\u0000${statement}\u0000${modelVersion}\u0000${promptVersion}`,
  );
}

/** Verify that a claim's span and quote really come from the supplied source. */
function assertGrounded(claim: Claim, source: ClaimSource): void {
  if (claim.sourceVersion !== source.sourceVersion) {
    throw new InvalidClaimError("source version does not match the supplied source");
  }
  if (claim.sourceVersion !== sourceVersionFor(source.text)) {
    throw new InvalidClaimError("supplied source version does not match its text");
  }
  if (claim.span.end <= claim.span.start) {
    throw new InvalidClaimError("span end must be after span start");
  }
  if (claim.span.end > source.text.length) {
    throw new InvalidClaimError("span lies outside the source text");
  }
  const exact = source.text.slice(claim.span.start, claim.span.end);
  if (claim.passage !== exact) {
    throw new InvalidClaimError("passage does not match the source text at that span");
  }
  // The archive reference comes from trusted context. A syntactically valid
  // but unrelated artifact would point a reader somewhere else entirely.
  for (const field of ["repository", "commit", "path", "hash"] as const) {
    if (claim.artifact[field] !== source.artifact[field]) {
      throw new InvalidClaimError("artifact does not match the supplied source artifact");
    }
  }
  // Verbatim annotations must occur in the validated passage. Otherwise model
  // output could turn vague source wording into an invented precise date or
  // qualifier while the quote itself stays genuine.
  for (const qualifier of claim.qualifiers) {
    if (!claim.passage.includes(qualifier)) {
      throw new InvalidClaimError("qualifier does not occur in the passage");
    }
  }
  for (const date of claim.dates) {
    if (!claim.passage.includes(date.text)) {
      throw new InvalidClaimError("date wording does not occur in the passage");
    }
    if (date.value !== undefined) {
      const canonical = isoDateFromText(date.text);
      if (canonical === undefined) {
        throw new InvalidClaimError("date value supplied for ambiguous date wording");
      }
      if (canonical !== date.value) {
        throw new InvalidClaimError("date value does not match the date wording");
      }
    }
  }
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function monthNumber(name: string): number | undefined {
  const index = MONTH_NAMES.indexOf(name.toLowerCase() as (typeof MONTH_NAMES)[number]);
  return index === -1 ? undefined : index + 1;
}

/**
 * Canonical ISO date for wording that states one unambiguously, else
 * undefined. Vague wording such as "last spring" is deliberately not parsed,
 * so a normalised value can never be attached to it.
 */
function isoDateFromText(text: string): string | undefined {
  const trimmed = text.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return isRealDate(year, month, day) ? trimmed : undefined;
  }

  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/.exec(trimmed);
  if (dayFirst) {
    const month = monthNumber(dayFirst[2] as string);
    const [day, year] = [Number(dayFirst[1]), Number(dayFirst[3])];
    if (month !== undefined && isRealDate(year, month, day)) {
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return undefined;
  }

  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(trimmed);
  if (monthFirst) {
    const month = monthNumber(monthFirst[1] as string);
    const [day, year] = [Number(monthFirst[2]), Number(monthFirst[3])];
    if (month !== undefined && isRealDate(year, month, day)) {
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return undefined;
  }

  return undefined;
}

/** Recompute the canonical claim ID from validated fields. */
function canonicalClaimId(claim: Claim): string {
  return claimIdFor({
    sourceVersion: claim.sourceVersion,
    start: claim.span.start,
    end: claim.span.end,
    statement: claim.statement,
    modelVersion: claim.extraction.modelVersion,
    promptVersion: claim.extraction.promptVersion,
  });
}

/**
 * Validate untrusted extracted output against its source. Rejects malformed
 * claims, fabricated quotes, mismatched spans, verbatim annotations the
 * passage does not contain, an ID that does not match the claim fields, and
 * unknown fields such as a truth verdict.
 */
export function parseClaim(input: unknown, source: ClaimSource): Claim {
  const parsed = ClaimSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidClaimError("structured output failed validation");
  }
  assertGrounded(parsed.data, source);
  if (parsed.data.id !== canonicalClaimId(parsed.data)) {
    throw new InvalidClaimError("id does not match the claim fields");
  }
  return parsed.data;
}

export interface ClaimDraft {
  statement: string;
  claimType: ClaimType;
  sourceVersion: string;
  span: ClaimSpan;
  passage: string;
  qualifiers?: string[];
  entities?: string[];
  dates?: DateMention[];
  extraction: ClaimExtractionMeta;
}

/**
 * Build, validate and identify one claim. The ID is computed from the
 * validated, normalised fields, never supplied; grounding is checked against
 * `source` exactly as {@link parseClaim} does.
 */
export function createClaim(draft: ClaimDraft, source: ClaimSource): Claim {
  const body = ClaimBodySchema.parse({
    schemaVersion: CLAIM_SCHEMA_VERSION,
    statement: draft.statement,
    claimType: draft.claimType,
    sourceVersion: draft.sourceVersion,
    artifact: source.artifact,
    span: draft.span,
    passage: draft.passage,
    qualifiers: draft.qualifiers ?? [],
    entities: draft.entities ?? [],
    dates: draft.dates ?? [],
    extraction: draft.extraction,
  });
  const id = claimIdFor({
    sourceVersion: body.sourceVersion,
    start: body.span.start,
    end: body.span.end,
    statement: body.statement,
    modelVersion: body.extraction.modelVersion,
    promptVersion: body.extraction.promptVersion,
  });
  return parseClaim({ ...body, id }, source);
}

/** Synthetic source text used by the documentation examples and their tests. */
const SYNTHETIC_FIRST = "The synthetic council said it may raise fees by 3% last spring.";
const SYNTHETIC_SECOND = "A synthetic critic called the plan shortsighted.";
export const SYNTHETIC_SOURCE_TEXT = `${SYNTHETIC_FIRST} ${SYNTHETIC_SECOND}`;

const SYNTHETIC_SOURCE_VERSION = sourceVersionFor(SYNTHETIC_SOURCE_TEXT);
const SYNTHETIC_ARTIFACT = {
  repository: "synthetic-archive",
  commit: "0123456789abcdef0123456789abcdef01234567",
  path: "sources/synthetic/example.txt",
  hash: `sha256:${"cd".repeat(32)}`,
};

/** Synthetic example claims, valid against {@link SYNTHETIC_SOURCE_TEXT}. */
export const SYNTHETIC_CLAIM_EXAMPLES: readonly unknown[] = [
  {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    id: claimIdFor({
      sourceVersion: SYNTHETIC_SOURCE_VERSION,
      start: 0,
      end: SYNTHETIC_FIRST.length,
      statement: SYNTHETIC_FIRST,
      modelVersion: "synthetic-model-v1",
      promptVersion: "claim-extraction-v1",
    }),
    statement: SYNTHETIC_FIRST,
    claimType: "ambiguous",
    sourceVersion: SYNTHETIC_SOURCE_VERSION,
    artifact: SYNTHETIC_ARTIFACT,
    span: { start: 0, end: SYNTHETIC_FIRST.length },
    passage: SYNTHETIC_FIRST,
    qualifiers: ["may"],
    entities: ["synthetic council"],
    dates: [{ text: "last spring" }],
    extraction: {
      modelVersion: "synthetic-model-v1",
      promptVersion: "claim-extraction-v1",
      extractedAt: "2026-02-01T00:00:00Z",
    },
  },
  {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    id: claimIdFor({
      sourceVersion: SYNTHETIC_SOURCE_VERSION,
      start: SYNTHETIC_FIRST.length + 1,
      end: SYNTHETIC_SOURCE_TEXT.length,
      statement: SYNTHETIC_SECOND,
      modelVersion: "synthetic-model-v1",
      promptVersion: "claim-extraction-v1",
    }),
    statement: SYNTHETIC_SECOND,
    claimType: "opinion",
    sourceVersion: SYNTHETIC_SOURCE_VERSION,
    artifact: SYNTHETIC_ARTIFACT,
    span: { start: SYNTHETIC_FIRST.length + 1, end: SYNTHETIC_SOURCE_TEXT.length },
    passage: SYNTHETIC_SECOND,
    qualifiers: [],
    entities: ["synthetic critic", "the plan"],
    dates: [],
    extraction: {
      modelVersion: "synthetic-model-v1",
      promptVersion: "claim-extraction-v1",
      extractedAt: "2026-02-01T00:00:00Z",
    },
  },
];
