import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import { sourceVersionFor } from "../content/fulltext-document.js";
import {
  ClaimTypeSchema,
  DateMentionSchema,
  canonicalDateValue,
  claimIdFor,
  parseClaim,
  type Claim,
  type ClaimSource,
} from "./claim.js";

/**
 * Indexed claim occurrence: one claim asserted in one source passage.
 *
 * Identity rules:
 * - `occurrenceId` comes from the post, source version and span only, so
 *   re-extracting the same passage (even with another model or prompt) and
 *   re-indexing it never inflates counts.
 * - `grouping.key` is a separate, revisable key for "the same claim" across
 *   posts. The default is normalised statement text; model-assisted grouping
 *   is labelled as such and is never proof of equivalence or truth.
 *
 * Attribution rules:
 * - The publisher (publication, and the post author when known) is recorded
 *   separately from the speaker who actually made the assertion.
 * - `speaker.kind` is `author-voice` (the post asserts it), `quoted` (someone
 *   else is reported as saying it), `unknown` or `uncertain`. A speaker name
 *   is only allowed with evidence: it must occur in the source text within the
 *   attribution span, so a name is never inferred from publication ownership.
 *
 * Date rules:
 * - `sourcePublishedAt` is the observed publication time of the post, not
 *   proof of when the claim was first asserted.
 * - `assertionDates` are only dates the passage itself states, carried from
 *   the validated claim. Nothing is invented; absence stays absent.
 */

export const CLAIM_OCCURRENCE_SCHEMA_VERSION = 1;
export const CLAIM_OCCURRENCE_INDEX_V1 = "steele-claim-occurrences-v1";

const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Span = z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }).strict();

export const SpeakerSchema = z
  .object({
    kind: z.enum(["author-voice", "quoted", "unknown", "uncertain"]),
    name: z.string().trim().min(1).max(200).optional(),
    /** Span of source text that names or attributes the speaker. */
    evidence: Span.optional(),
  })
  .strict()
  .describe("Who actually made the assertion, as evidenced by the source.");
export type Speaker = z.infer<typeof SpeakerSchema>;

export const ClaimOccurrenceSchema = z
  .object({
    schemaVersion: z.literal(CLAIM_OCCURRENCE_SCHEMA_VERSION),
    occurrenceId: Hash.describe("Stable ID of this claim in this passage of this source version."),
    grouping: z
      .object({
        key: Hash,
        method: z.enum(["normalised-text", "model-assisted"]),
        version: z.string().min(1).max(100),
      })
      .strict()
      .describe("Revisable grouping of equivalent claims; not proof of equivalence or truth."),
    publicationId: z.string().min(1),
    postId: z.string().min(1),
    url: z.url({ protocol: /^https$/ }),
    claimId: Hash,
    statement: z.string().trim().min(1).max(2000),
    claimType: ClaimTypeSchema,
    qualifiers: z.array(z.string().min(1)).max(20),
    passage: z.string().min(1),
    span: Span,
    transcriptTime: z
      .object({ startSeconds: z.number().nonnegative(), endSeconds: z.number().nonnegative() })
      .strict()
      .optional()
      .describe("Media time of the passage, only when supplied transcript timings cover it."),
    sourceVersion: Hash,
    artifact: ArtifactReferenceSchema,
    sourcePublishedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Observed publication time of the post; not the date the claim was first made."),
    assertionDates: z.array(DateMentionSchema).max(20),
    themes: z.array(z.string().min(1).max(60)).max(30),
    assertionKind: z
      .enum(["assertion", "quotation", "question", "speculation"])
      .optional()
      .describe("How the passage puts the claim; questions and speculation are not assertions."),
    publisher: z
      .object({
        publicationId: z.string().min(1),
        author: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
    speaker: SpeakerSchema,
    extraction: z
      .object({
        modelVersion: z.string().min(1),
        promptVersion: z.string().min(1),
        extractedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict()
  .meta({
    title: "ClaimOccurrence",
    description:
      "One claim asserted in one source passage, with provenance and attribution. No verdict.",
  });
export type ClaimOccurrence = z.infer<typeof ClaimOccurrenceSchema>;

export class InvalidClaimOccurrenceError extends Error {
  constructor(reason: string) {
    super(`Invalid claim occurrence: ${reason}`);
    this.name = "InvalidClaimOccurrenceError";
  }
}

const sha = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;

/** Stable occurrence ID from post, source version and span. */
export function occurrenceIdFor(input: {
  publicationId: string;
  postId: string;
  sourceVersion: string;
  start: number;
  end: number;
}): string {
  return sha([input.publicationId, input.postId, input.sourceVersion, input.start, input.end]);
}

/** Default grouping key: normalised statement text (lower case, collapsed whitespace, no punctuation). */
export function normalisedClaimKey(statement: string): string {
  return sha(
    statement
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s%]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export interface OccurrenceSource extends ClaimSource {
  publicationId: string;
  postId: string;
  url: string;
  /** Observed publication time of the post, when known. */
  publishedAt?: string;
  /** Post author when the source names one. */
  author?: string;
  /** Supplied transcript timings aligned to `text`, when available. */
  transcriptTimings?: Array<{
    start: number;
    end: number;
    startSeconds: number;
    endSeconds: number;
  }>;
}

/** True when `name` occurs in `text` not embedded in a longer word or number. */
function containsWholeMention(text: string, name: string): boolean {
  const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    if (!isWord(text[at - 1]) && !isWord(text[at + name.length])) return true;
  }
  return false;
}

function assertSpeakerEvidence(speaker: Speaker, text: string): void {
  if (speaker.name === undefined) return;
  if (speaker.kind === "author-voice" || speaker.kind === "unknown") {
    throw new InvalidClaimOccurrenceError("a speaker name needs a quoted or uncertain attribution");
  }
  const evidence = speaker.evidence;
  if (!evidence || evidence.end <= evidence.start || evidence.end > text.length) {
    throw new InvalidClaimOccurrenceError("a speaker name needs an attribution span in the source");
  }
  if (!containsWholeMention(text.slice(evidence.start, evidence.end), speaker.name)) {
    throw new InvalidClaimOccurrenceError("speaker name does not occur in the attribution span");
  }
}

function transcriptTimeFor(source: OccurrenceSource, span: { start: number; end: number }) {
  const covering = (source.transcriptTimings ?? []).filter(
    (t) => t.end > span.start && t.start < span.end,
  );
  if (covering.length === 0) return undefined;
  return {
    startSeconds: Math.min(...covering.map((t) => t.startSeconds)),
    endSeconds: Math.max(...covering.map((t) => t.endSeconds)),
  };
}

/** Build a validated occurrence from a validated claim and its source context. */
export function createClaimOccurrence(input: {
  claim: Claim;
  source: OccurrenceSource;
  speaker: Speaker;
  themes?: string[];
  assertionKind?: "assertion" | "quotation" | "question" | "speculation";
  grouping?: { key: string; method: "model-assisted"; version: string };
}): ClaimOccurrence {
  const claim = parseClaim(input.claim, input.source);
  const span = claim.span;
  const occurrence = ClaimOccurrenceSchema.parse({
    schemaVersion: CLAIM_OCCURRENCE_SCHEMA_VERSION,
    occurrenceId: occurrenceIdFor({
      publicationId: input.source.publicationId,
      postId: input.source.postId,
      sourceVersion: claim.sourceVersion,
      start: span.start,
      end: span.end,
    }),
    grouping: input.grouping ?? {
      key: normalisedClaimKey(claim.statement),
      method: "normalised-text",
      version: "1",
    },
    publicationId: input.source.publicationId,
    postId: input.source.postId,
    url: input.source.url,
    claimId: claim.id,
    statement: claim.statement,
    claimType: claim.claimType,
    qualifiers: claim.qualifiers,
    passage: claim.passage,
    span,
    ...(transcriptTimeFor(input.source, span)
      ? { transcriptTime: transcriptTimeFor(input.source, span) }
      : {}),
    sourceVersion: claim.sourceVersion,
    artifact: claim.artifact,
    ...(input.source.publishedAt ? { sourcePublishedAt: input.source.publishedAt } : {}),
    assertionDates: claim.dates,
    themes: [
      ...new Set(
        (input.themes ?? [])
          .map((t) => t.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60))
          .filter(Boolean),
      ),
    ],
    ...(input.assertionKind ? { assertionKind: input.assertionKind } : {}),
    publisher: {
      publicationId: input.source.publicationId,
      ...(input.source.author ? { author: input.source.author } : {}),
    },
    speaker: input.speaker,
    extraction: claim.extraction,
  });
  assertSpeakerEvidence(occurrence.speaker, input.source.text);
  return occurrence;
}

/** Validate a stored or received occurrence against its source text. */
export function parseClaimOccurrence(input: unknown, source: OccurrenceSource): ClaimOccurrence {
  const parsed = ClaimOccurrenceSchema.safeParse(input);
  if (!parsed.success) throw new InvalidClaimOccurrenceError("structure failed validation");
  const o = parsed.data;
  if (
    o.sourceVersion !== source.sourceVersion ||
    sourceVersionFor(source.text) !== o.sourceVersion
  ) {
    throw new InvalidClaimOccurrenceError("source version does not match the supplied source");
  }
  if (o.publicationId !== source.publicationId || o.postId !== source.postId) {
    throw new InvalidClaimOccurrenceError("occurrence belongs to another post");
  }
  if (o.span.end <= o.span.start || o.span.end > source.text.length) {
    throw new InvalidClaimOccurrenceError("span lies outside the source text");
  }
  if (source.text.slice(o.span.start, o.span.end) !== o.passage) {
    throw new InvalidClaimOccurrenceError("passage does not match the source text at that span");
  }
  if (o.occurrenceId !== occurrenceIdFor({ ...o, start: o.span.start, end: o.span.end })) {
    throw new InvalidClaimOccurrenceError(
      "occurrence ID does not match its post, version and span",
    );
  }
  const expectedClaimId = claimIdFor({
    sourceVersion: o.sourceVersion,
    start: o.span.start,
    end: o.span.end,
    statement: o.statement,
    modelVersion: o.extraction.modelVersion,
    promptVersion: o.extraction.promptVersion,
  });
  if (o.claimId !== expectedClaimId) {
    throw new InvalidClaimOccurrenceError("claim ID does not match the claim fields");
  }
  // A text-derived grouping key must be the one its statement produces;
  // model-assisted keys are revisable and validated where they are assigned.
  if (
    o.grouping.method === "normalised-text" &&
    o.grouping.version === "1" &&
    o.grouping.key !== normalisedClaimKey(o.statement)
  ) {
    throw new InvalidClaimOccurrenceError("grouping key does not match the statement");
  }
  // Transcript time is derived from the supplied timings, never stored freely.
  const expectedTime = transcriptTimeFor(source, o.span);
  if (JSON.stringify(o.transcriptTime ?? null) !== JSON.stringify(expectedTime ?? null)) {
    throw new InvalidClaimOccurrenceError("transcript time does not match the supplied timings");
  }
  for (const date of o.assertionDates) {
    if (!o.passage.includes(date.text)) {
      throw new InvalidClaimOccurrenceError("assertion date wording does not occur in the passage");
    }
    // A normalised value is only allowed when the wording itself states it.
    if (date.value !== undefined && canonicalDateValue(date.text) !== date.value) {
      throw new InvalidClaimOccurrenceError("assertion date value does not match its wording");
    }
  }
  for (const field of ["repository", "commit", "path", "hash"] as const) {
    if (o.artifact[field] !== source.artifact[field]) {
      throw new InvalidClaimOccurrenceError("artifact does not match the supplied source artifact");
    }
  }
  if (o.publisher.publicationId !== o.publicationId) {
    throw new InvalidClaimOccurrenceError("publisher does not match the occurrence publication");
  }
  // Post metadata comes from the trusted source, never from the stored record.
  if (
    o.url !== source.url ||
    o.sourcePublishedAt !== source.publishedAt ||
    o.publisher.author !== source.author
  ) {
    throw new InvalidClaimOccurrenceError("post metadata does not match the supplied source");
  }
  // Qualifiers are verbatim wording, so they must occur in the passage.
  for (const qualifier of o.qualifiers) {
    if (!o.passage.includes(qualifier)) {
      throw new InvalidClaimOccurrenceError("qualifier does not occur in the passage");
    }
  }
  assertSpeakerEvidence(o.speaker, source.text);
  return o;
}

/** JSON Schema (draft 2020-12) for {@link ClaimOccurrenceSchema}. */
export function claimOccurrenceJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ClaimOccurrenceSchema) as Record<string, unknown>;
}

/** Explicit strict Elasticsearch mapping for {@link CLAIM_OCCURRENCE_INDEX_V1}. */
export const CLAIM_OCCURRENCE_INDEX_MAPPING = {
  dynamic: "strict",
  properties: {
    schemaVersion: { type: "integer" },
    occurrenceId: { type: "keyword" },
    grouping: {
      type: "object",
      properties: {
        key: { type: "keyword" },
        method: { type: "keyword" },
        version: { type: "keyword" },
      },
    },
    publicationId: { type: "keyword" },
    postId: { type: "keyword" },
    url: { type: "keyword" },
    claimId: { type: "keyword" },
    statement: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 512 } } },
    claimType: { type: "keyword" },
    qualifiers: { type: "keyword" },
    passage: { type: "text" },
    span: { type: "object", properties: { start: { type: "integer" }, end: { type: "integer" } } },
    transcriptTime: {
      type: "object",
      properties: { startSeconds: { type: "float" }, endSeconds: { type: "float" } },
    },
    sourceVersion: { type: "keyword" },
    artifact: {
      type: "object",
      properties: {
        repository: { type: "keyword" },
        commit: { type: "keyword" },
        path: { type: "keyword" },
        hash: { type: "keyword" },
      },
    },
    sourcePublishedAt: { type: "date" },
    assertionDates: {
      type: "object",
      properties: { text: { type: "keyword" }, value: { type: "date" } },
    },
    themes: { type: "keyword" },
    assertionKind: { type: "keyword" },
    publisher: {
      type: "object",
      properties: { publicationId: { type: "keyword" }, author: { type: "keyword" } },
    },
    speaker: {
      type: "object",
      properties: {
        kind: { type: "keyword" },
        name: { type: "keyword" },
        evidence: {
          type: "object",
          properties: { start: { type: "integer" }, end: { type: "integer" } },
        },
      },
    },
    extraction: {
      type: "object",
      properties: {
        modelVersion: { type: "keyword" },
        promptVersion: { type: "keyword" },
        extractedAt: { type: "date" },
      },
    },
  },
} as const;
