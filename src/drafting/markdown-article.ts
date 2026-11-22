import { z } from "zod";
import { PublicationFieldsSchema } from "../content/publication-fields.js";

/**
 * Markdown article contract (#535, slice 1: format and parser).
 *
 * The writer returns an ordinary Markdown body with a small JSON header,
 * so prose is never embedded in JSON strings:
 *
 *     ---json
 *     {"title": "...", "subtitle": "...", "excerpt": "...", "provenance": {...}}
 *     ---
 *     Markdown body…
 *
 * Why this delimiter is unambiguous: the document must start with the exact
 * line `---json`, and the header ends at the first line that is exactly
 * `---`. A JSON string cannot contain a raw line break, so no line inside a
 * valid JSON header can be a bare `---`; the body may freely contain
 * horizontal rules, code fences, quotation marks and `---json` text.
 *
 * Validation is strict and explicit: unknown keys, duplicate keys, missing
 * or oversized fields, malformed JSON and an empty or oversized body all
 * fail with a named reason. The header and body stay untrusted data: nothing
 * in them can select tools, prompts or publishing policy, because the parser
 * only ever returns these fixed fields.
 */

export const MARKDOWN_ARTICLE_FORMAT = "markdown-json-header-v1";
const OPEN = "---json";
const CLOSE = "---";
/** Bound on the header block, in characters. */
export const MAX_HEADER_CHARS = 20_000;
/** Bound on the Markdown body, in characters. */
export const MAX_BODY_CHARS = 100_000;

const Index = z.number().int().min(0);

/**
 * Claim and evidence references kept beside the prose (#535): the existing
 * deterministic evidence checks and the independent verifier still see which
 * claims the article answers, with which verdict and which supplied evidence.
 */
export const ArticleProvenanceSchema = z
  .object({
    responses: z
      .array(
        z
          .object({
            claimRecordId: z.string().min(1).max(200),
            verdict: z.enum(["supported", "contradicted", "unsupported", "unresolved"]),
            evidence: z.array(Index).max(20),
          })
          .strict(),
      )
      .max(50),
    narrativeHistory: z.array(Index).max(20).optional(),
    widerContextBackground: z.array(Index).max(30).optional(),
  })
  .strict();
export type ArticleProvenance = z.infer<typeof ArticleProvenanceSchema>;

export const ArticleHeaderSchema = z
  .object({
    title: PublicationFieldsSchema.shape.title,
    subtitle: PublicationFieldsSchema.shape.subtitle,
    excerpt: PublicationFieldsSchema.shape.excerpt,
    provenance: ArticleProvenanceSchema,
  })
  .strict();
export type ArticleHeader = z.infer<typeof ArticleHeaderSchema>;

export interface MarkdownArticle {
  header: ArticleHeader;
  /** The Markdown body exactly as written, with line endings normalised to `\n`. */
  body: string;
}

export type MarkdownArticleErrorCode =
  | "missing-header"
  | "unterminated-header"
  | "oversized-header"
  | "malformed-header"
  | "duplicate-header-key"
  | "invalid-header"
  | "empty-body"
  | "oversized-body";

export class MarkdownArticleError extends Error {
  constructor(
    readonly code: MarkdownArticleErrorCode,
    readonly detail?: string,
  ) {
    super(`markdown article: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "MarkdownArticleError";
  }
}

/** Parse and validate one writer response in the Markdown article format. */
export function parseMarkdownArticle(text: string): MarkdownArticle {
  // Normalise line endings and a leading byte-order mark only; the body is
  // otherwise kept exactly.
  const normalised = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = normalised.split("\n");
  if (lines[0]?.trimEnd() !== OPEN) throw new MarkdownArticleError("missing-header");
  const close = lines.findIndex((line, i) => i > 0 && line.trimEnd() === CLOSE);
  if (close < 0) throw new MarkdownArticleError("unterminated-header");
  const headerText = lines.slice(1, close).join("\n");
  if (headerText.length > MAX_HEADER_CHARS) throw new MarkdownArticleError("oversized-header");

  let raw: unknown;
  try {
    raw = JSON.parse(headerText);
  } catch {
    throw new MarkdownArticleError("malformed-header");
  }
  const duplicate = firstDuplicateKey(headerText);
  if (duplicate !== undefined) throw new MarkdownArticleError("duplicate-header-key", duplicate);
  const header = ArticleHeaderSchema.safeParse(raw);
  if (!header.success) {
    const issue = header.error.issues[0];
    throw new MarkdownArticleError(
      "invalid-header",
      issue ? `${issue.path.join(".") || "header"}: ${issue.code}` : undefined,
    );
  }

  const body = lines
    .slice(close + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  if (body.length === 0) throw new MarkdownArticleError("empty-body");
  if (body.length > MAX_BODY_CHARS) throw new MarkdownArticleError("oversized-body");
  return { header: header.data, body: `${body}\n` };
}

/** Serialise an article in the exact format `parseMarkdownArticle` accepts. */
export function serialiseMarkdownArticle(article: MarkdownArticle): string {
  const header = ArticleHeaderSchema.parse(article.header);
  // `JSON.stringify` escapes line breaks, so the header can never contain a
  // bare closing delimiter line.
  // Readable when it fits; compact otherwise, so every valid header the
  // parser accepts also serialises within the parser's own size bound.
  const pretty = JSON.stringify(header, null, 2);
  const json = pretty.length <= MAX_HEADER_CHARS ? pretty : JSON.stringify(header);
  if (json.length > MAX_HEADER_CHARS) throw new MarkdownArticleError("oversized-header");
  return `${OPEN}\n${json}\n${CLOSE}\n\n${article.body.replace(/\s+$/, "")}\n`;
}

/**
 * The first object key that appears twice within one JSON object, scanning
 * the text itself: `JSON.parse` silently keeps the last duplicate, which
 * would let a second value override a validated first one.
 */
function firstDuplicateKey(json: string): string | undefined {
  const stack: Array<{ keys: Set<string>; expectKey: boolean } | null> = [];
  let i = 0;
  while (i < json.length) {
    const c = json[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.expectKey) {
        const key = JSON.parse(json.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top) top.expectKey = true;
    }
    i++;
  }
  return undefined;
}
