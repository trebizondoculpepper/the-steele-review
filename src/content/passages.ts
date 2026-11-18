import { z } from "zod";
import { sourceVersionFor } from "./fulltext-document.js";

/**
 * Deterministic passage splitting.
 *
 * A passage is a contiguous span of normalised source text with the exact
 * coordinates needed to retrieve it again. Splitting never rewrites the text:
 * `text.slice(start, end)` is the passage body, so a span always reconstructs
 * the source exactly.
 *
 * Bounds and overlap:
 * - A passage is at most {@link DEFAULT_PASSAGE_MAX_CHARS} UTF-16 code units.
 * - Consecutive passages overlap by {@link DEFAULT_PASSAGE_OVERLAP_CHARS} code
 *   units, so a sentence cut at a boundary still has context on both sides.
 *   The overlap is exact except where it would start inside a surrogate pair,
 *   in which case it starts one unit later.
 * - Cuts prefer a paragraph break, then a sentence end, then any whitespace,
 *   and only then a hard cut. A cut never splits a surrogate pair, so an emoji
 *   or other astral character is never torn between passages.
 *
 * Identity:
 * - `sourceId` is the stable logical identity of the source (for Substack,
 *   `substack/<publicationId>/<postId>`). Two posts with byte-identical text
 *   are still different sources, so the identifier is part of every passage.
 * - `sourceVersion` is the content hash of the whole text (see
 *   {@link sourceVersionFor}) and is validated against it, so a passage set
 *   cannot claim a version its text does not have.
 * - `splitterVersion` is part of every passage ID. Changing the algorithm or
 *   its defaults means incrementing the version, which deliberately changes
 *   every derived ID and forces downstream records to be rebuilt rather than
 *   silently mixed with passages produced by different rules.
 *
 * Timestamps are passed through when the source supplies them and omitted
 * otherwise; splitting never invents one.
 */

export const PASSAGE_SPLITTER_VERSION = 1;
export const DEFAULT_PASSAGE_MAX_CHARS = 1600;
export const DEFAULT_PASSAGE_OVERLAP_CHARS = 200;
/** Minimum passage length before a boundary cut is considered. */
export const DEFAULT_PASSAGE_MIN_CHARS = 400;

const SourceVersionSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .describe("Content hash of the whole source text, as `sha256:<64 lower-case hex>`.");

const IsoDateSchema = z.iso.datetime({ offset: true });

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/;

export interface PassageInput {
  /** Stable logical source identity, e.g. `substack/<publicationId>/<postId>`. */
  sourceId: string;
  /** Normalised source text to split. */
  text: string;
  /** Content hash of `text`; must equal {@link sourceVersionFor}`(text)`. */
  sourceVersion: string;
  /** First publication time, when the source supplies it. */
  publishedAt?: string;
  /** Last update time, when the source supplies it. */
  updatedAt?: string;
}

export interface Passage {
  /** Stable ID derived from source identity, versions and span. */
  id: string;
  /** Zero-based position in the passage set. */
  index: number;
  /** Exact source slice `text.slice(start, end)`. */
  text: string;
  /** Inclusive start offset in UTF-16 code units. */
  start: number;
  /** Exclusive end offset in UTF-16 code units. */
  end: number;
  sourceId: string;
  sourceVersion: string;
  splitterVersion: number;
  publishedAt?: string;
  updatedAt?: string;
}

export interface PassageSet {
  sourceId: string;
  sourceVersion: string;
  splitterVersion: number;
  maxChars: number;
  overlapChars: number;
  passages: Passage[];
}

export class InvalidPassageInputError extends Error {
  constructor(reason: string) {
    super(`Invalid passage input: ${reason}`);
    this.name = "InvalidPassageInputError";
  }
}

/** Stable passage ID: source version, splitter version, ordinal and span. */
export function passageIdFor(input: {
  sourceId: string;
  sourceVersion: string;
  splitterVersion: number;
  index: number;
  start: number;
  end: number;
}): string {
  const { sourceId, sourceVersion, splitterVersion, index, start, end } = input;
  return sourceVersionFor(
    `${sourceId}\u0000${sourceVersion}\u0000v${splitterVersion}\u0000${index}\u0000${start}\u0000${end}`,
  );
}

/** True when `index` does not sit between the halves of a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

/** Last sentence-ending position in `text[from, to)`, or -1. */
function lastSentenceEnd(text: string, from: number, to: number): number {
  const slice = text.slice(from, to);
  const pattern = /[.!?]["')\]]?\s/g;
  let end = -1;
  for (let match = pattern.exec(slice); match !== null; match = pattern.exec(slice)) {
    end = from + match.index + match[0].length;
  }
  return end;
}

/**
 * Choose the cut point for a passage ending no later than `to`. The result is
 * always in `(from, to]`, so the loop advances and a passage never exceeds the
 * configured maximum. Every search is bounded to the current window, so cost
 * stays linear in the passage length rather than in the whole source.
 */
function chooseCut(text: string, from: number, to: number): number {
  const window = text.slice(from, to);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= 0) return Math.min(to, from + paragraph + 2);

  const sentence = lastSentenceEnd(text, from, to);
  if (sentence > from) return Math.min(to, sentence);

  for (let index = to - 1; index > from; index -= 1) {
    if (/\s/.test(text[index] as string)) return index + 1;
  }

  return splitsSurrogatePair(text, to) ? to - 1 : to;
}

export interface PassageOptions {
  maxChars?: number;
  overlapChars?: number;
  minChars?: number;
}

/**
 * Split one versioned text into ordered passages. Pure and deterministic: the
 * same input and options always produce the same spans and IDs.
 */
export function splitPassages(input: PassageInput, options: PassageOptions = {}): PassageSet {
  const maxChars = options.maxChars ?? DEFAULT_PASSAGE_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_PASSAGE_OVERLAP_CHARS;
  const minChars = options.minChars ?? DEFAULT_PASSAGE_MIN_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new InvalidPassageInputError("maxChars must be a positive integer");
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new InvalidPassageInputError("overlapChars must be an integer below maxChars");
  }
  if (!Number.isInteger(minChars) || minChars < 0 || minChars > maxChars) {
    throw new InvalidPassageInputError("minChars must be an integer at or below maxChars");
  }
  if (typeof input.text !== "string") {
    throw new InvalidPassageInputError("text must be a string");
  }
  if (typeof input.sourceId !== "string" || !SOURCE_ID.test(input.sourceId)) {
    throw new InvalidPassageInputError(
      "sourceId must be a stable logical identifier of 1-300 safe characters",
    );
  }
  if (!SourceVersionSchema.safeParse(input.sourceVersion).success) {
    throw new InvalidPassageInputError("sourceVersion must be sha256:<64 lower-case hex>");
  }
  if (input.sourceVersion !== sourceVersionFor(input.text)) {
    throw new InvalidPassageInputError("sourceVersion does not match the supplied text");
  }
  for (const field of ["publishedAt", "updatedAt"] as const) {
    const value = input[field];
    if (value !== undefined && !IsoDateSchema.safeParse(value).success) {
      throw new InvalidPassageInputError(`${field} must be an ISO 8601 datetime with offset`);
    }
  }

  const text = input.text;
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    const limit = Math.min(start + maxChars, text.length);
    let end = limit;
    if (limit < text.length) {
      // Clamp the boundary window below the limit so `chooseCut` always has a
      // non-empty range and therefore always applies surrogate-pair safety,
      // including when minChars === maxChars would otherwise leave none.
      const from = Math.min(start + Math.max(minChars, 1), limit - 1);
      end = chooseCut(text, from, limit);
    }
    end = Math.max(start + 1, Math.min(end, text.length));
    spans.push({ start, end });
    if (end >= text.length) break;
    let next = Math.max(end - overlapChars, start + 1);
    if (splitsSurrogatePair(text, next)) next += 1;
    start = Math.min(next, end);
  }

  const passages = spans.map(({ start: spanStart, end: spanEnd }, index) => {
    const id = passageIdFor({
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      splitterVersion: PASSAGE_SPLITTER_VERSION,
      index,
      start: spanStart,
      end: spanEnd,
    });
    return {
      id,
      index,
      text: text.slice(spanStart, spanEnd),
      start: spanStart,
      end: spanEnd,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      splitterVersion: PASSAGE_SPLITTER_VERSION,
      ...(input.publishedAt === undefined ? {} : { publishedAt: input.publishedAt }),
      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    };
  });

  return {
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    splitterVersion: PASSAGE_SPLITTER_VERSION,
    maxChars,
    overlapChars,
    passages,
  };
}
