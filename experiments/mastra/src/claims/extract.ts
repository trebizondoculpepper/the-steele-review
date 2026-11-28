import type { GitRepository } from "../common/git/index.js";
import type { ChatModel } from "../common/model/openrouter.js";
import type { ArticleRecord } from "../content/substack-article.js";
import {
  normalise,
  normaliseForQuotes,
  runOperation,
  sha256,
  type OperationMeta,
  type Rejection,
  type SourceInfo,
  type SourceRef,
  type Timings,
  type Usage,
} from "../extraction/operation.js";

/**
 * Grounded claim utterances from one retained source version (#961), on the
 * shared extraction operation (src/extraction/operation.ts).
 *
 * One bounded model call proposes up to MAX_CLAIMS utterances. Each is kept
 * only if its quote occurs verbatim in the source text; rejected candidates
 * are listed with a reason. Every saved claim records where it is in the
 * source (character offsets, and for a transcript the segment range and
 * times), who said it as far as the source supports, and when:
 *
 * - article: the article's resolved author, with its attribution basis;
 * - transcript: the article's author only when the recording has a single
 *   speaker label throughout; otherwise the speaker is explicitly unknown,
 *   with the diarisation label of the quote's segments when there is one;
 * - date: the source's publication date (when the source gives one).
 *
 *   claims/<platform>/<source>/<item>/<operation>/<claimId>.json   (indexed)
 *   claims/<platform>/<source>/<item>/<operation>/operation.meta   (not indexed)
 *
 * Claim IDs hash the source blob and the normalised quote, so they are stable.
 */

export const CLAIMS = "claims";
export const PROMPT_NAME = "claim-utterances-v1";
export const DEFAULT_CLAIM_MODEL = "deepseek/deepseek-v4.1-flash";
export const MAX_CLAIMS = 20;

export const CLAIMS_DECLARATION = {
  mappingVersion: 1,
  mapping: {
    dynamic: "strict",
    properties: {
      schema: { type: "keyword" },
      claimId: { type: "keyword" },
      operation: { type: "keyword" },
      rank: { type: "integer" },
      quote: { type: "text" },
      claim: { type: "text" },
      speaker: {
        type: "object",
        properties: { name: { type: "keyword" }, id: { type: "keyword" }, basis: { type: "keyword" }, label: { type: "keyword" } },
      },
      date: { type: "date" },
      location: {
        type: "object",
        properties: {
          charStart: { type: "integer" },
          charEnd: { type: "integer" },
          segmentStart: { type: "integer" },
          segmentEnd: { type: "integer" },
          startSeconds: { type: "float" },
          endSeconds: { type: "float" },
        },
      },
      source: {
        type: "object",
        properties: {
          path: { type: "keyword" },
          commit: { type: "keyword" },
          blob: { type: "keyword" },
          sourceId: { type: "keyword" },
          itemId: { type: "keyword" },
          url: { type: "keyword" },
          textType: { type: "keyword" },
        },
      },
      prompt: { type: "keyword" },
      model: { type: "keyword" },
      createdAt: { type: "date" },
    },
  },
} as const;

export interface ClaimUtterance {
  schema: "claim-utterance-v1";
  claimId: string;
  operation: string;
  rank: number;
  quote: string;
  claim: string;
  speaker: {
    name: string | null;
    id: string | null;
    /** post-byline | source-configured | single-speaker-recording | unknown */
    basis: string;
    /** Diarisation label of the quote's transcript segments, when consistent. */
    label: string | null;
  };
  /** The source's publication date, or null when it gives none. */
  date: string | null;
  location: {
    /** Offsets in the whitespace-normalised source text. */
    charStart: number;
    charEnd: number;
    segmentStart?: number;
    segmentEnd?: number;
    startSeconds?: number;
    endSeconds?: number;
  };
  source: SourceInfo;
  prompt: string;
  model: string;
  createdAt: string;
}

export interface ExtractResult {
  operation: string;
  outcome: OperationMeta["outcome"];
  reused: boolean;
  claims: Array<{ claimId: string; quote: string; path: string }>;
  rejected: Rejection[];
  warnings: string[];
  usage: Usage;
  timings: Timings;
  reason?: string;
  commit?: string;
}

export interface ExtractOptions {
  repo: GitRepository;
  model: ChatModel;
  modelId?: string;
  branch?: string;
  now?: () => Date;
}

interface Segment {
  start: number;
  end: number;
  text: string;
  words?: Array<{ speaker?: string }>;
  /** The retained word metadata was malformed: no speaker evidence for this segment. */
  malformed?: boolean;
}

/** Where each transcript segment sits in the whitespace-normalised text, and its speaker label. */
function segmentIndex(segments: Segment[]) {
  const spans: Array<{ from: number; to: number; start: number; end: number; label: string | null; index: number }> = [];
  let offset = 0;
  for (const [index, s] of segments.entries()) {
    const text = normaliseForQuotes(s.text);
    if (!text) continue;
    if (offset > 0) offset += 1; // the single space that joins segments after normalisation
    const words = s.words ?? [];
    const labels = new Set(words.map((w) => w.speaker).filter((l): l is string => Boolean(l)));
    // A label counts only if every word carries it and the metadata was well-formed.
    const complete = !s.malformed && words.length > 0 && words.every((w) => w.speaker);
    // `index` is the segment's position in the retained transcript.raw, blanks included.
    spans.push({ from: offset, to: offset + text.length, start: s.start, end: s.end, label: complete && labels.size === 1 ? [...labels][0]! : null, index });
    offset += text.length;
  }
  return spans;
}

export async function extractClaims(ref: SourceRef, options: ExtractOptions): Promise<ExtractResult> {
  // The retained transcript segments (if any) give times and speaker labels.
  const folder = ref.path.replace(/\/article\.json$/, "");
  let segments: Segment[] | null = null;
  const raw = await options.repo.readText(ref.commit, `${folder}/transcript.raw`).catch(() => null);
  let malformedWords = false;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw.text);
      // Untrusted retained data: keep only well-formed segments, and only
      // well-formed word speaker labels (anything else is no speaker evidence).
      if (Array.isArray(parsed) && parsed.every((s) => s && typeof s === "object" && typeof s.text === "string" && typeof s.start === "number" && typeof s.end === "number"))
        segments = parsed.map((s: Record<string, unknown>) => {
          const words = Array.isArray(s.words) ? s.words : s.words === undefined ? [] : null;
          if (words === null || (words && !words.every((w) => w && typeof w === "object"))) malformedWords = true;
          return {
            start: s.start as number,
            end: s.end as number,
            text: s.text as string,
            words: (Array.isArray(words) ? words : []).filter((w): w is { speaker?: string } => Boolean(w) && typeof w === "object").map((w) => ({
              speaker: typeof w.speaker === "string" ? w.speaker : undefined,
            })),
            ...(words === null || (Array.isArray(words) && words.some((w) => !w || typeof w !== "object")) ? { malformed: true } : {}),
          } as Segment;
        });
    } catch {
      segments = null;
    }
  }

  const result = await runOperation<ClaimUtterance>(
    {
      collection: CLAIMS,
      declaration: CLAIMS_DECLARATION,
      metaSchema: "claim-operation-v1",
      promptName: PROMPT_NAME,
      maxTokens: 4000,
      temperature: 0,
      buildUser: (prompt, record, input, textType) =>
        prompt.userTemplate
          .replace("{{source.title}}", () => record.title ?? "")
          .replace("{{source.medium}}", () => record.medium ?? "unknown")
          .replace("{{source.textType}}", () => textType)
          .replace("{{source.text}}", () => input.replaceAll("</source>", "&lt;/source>")),
      validate: (parsed, ctx) => {
        const text = normaliseForQuotes(ctx.input);
        const warnings: string[] = [];
        const rejected: Rejection[] = [];
        const docs: Array<{ id: string; doc: ClaimUtterance }> = [];
        const list = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { claims?: unknown }).claims : undefined;
        if (!Array.isArray(list)) return { docs, rejected: [{ rank: 0, reason: "no-claims-array" }] };

        const isTranscript = ctx.source.textType === "transcript";
        const spans = isTranscript && segments ? segmentIndex(segments) : null;
        if (isTranscript && !spans) warnings.push("transcript-segments-unavailable");
        if (isTranscript && malformedWords) warnings.push("transcript-word-metadata-malformed");
        // The author is named only on complete evidence: every segment carries exactly
        // one speaker label, and it is the same label throughout. Unlabelled or
        // mixed-label segments leave the speaker unknown.
        const singleSpeaker = Boolean(spans && spans.length > 0 && spans.every((s) => s.label) && new Set(spans.map((s) => s.label)).size === 1);
        const speakerFor = (label: string | null): ClaimUtterance["speaker"] => {
          const author = ctx.record.attribution;
          if (!isTranscript)
            return author?.author
              ? { name: author.author, id: author.authorId ?? null, basis: author.basis, label: null }
              : { name: null, id: null, basis: "unknown", label: null };
          // A recording: the author only when one speaker is heard throughout.
          if (singleSpeaker && author?.author)
            return { name: author.author, id: author.authorId ?? null, basis: "single-speaker-recording", label };
          return { name: null, id: null, basis: "unknown", label };
        };

        const seen = new Set<string>();
        list.slice(0, MAX_CLAIMS).forEach((c, i) => {
          const rank = i + 1;
          if (!c || typeof c !== "object") return rejected.push({ rank, reason: "not-an-object" });
          const { quote, claim } = c as Record<string, unknown>;
          if (typeof quote !== "string" || typeof claim !== "string" || !normalise(claim)) return rejected.push({ rank, reason: "invalid-fields" });
          const q = normaliseForQuotes(quote);
          const words = q.split(" ").filter(Boolean).length;
          if (words < 8 || words > 80) return rejected.push({ rank, reason: "quote-length" });
          const at = text.indexOf(q);
          if (at < 0) return rejected.push({ rank, reason: "quote-not-in-source" });
          const key = q.toLowerCase();
          if (seen.has(key)) return rejected.push({ rank, reason: "duplicate-quote" });
          seen.add(key);

          const location: ClaimUtterance["location"] = { charStart: at, charEnd: at + q.length };
          let label: string | null = null;
          if (spans) {
            const covering = spans.filter((s) => s.to > location.charStart && s.from < location.charEnd);
            if (covering.length) {
              location.segmentStart = covering[0]!.index;
              location.segmentEnd = covering.at(-1)!.index;
              location.startSeconds = covering[0]!.start;
              location.endSeconds = covering.at(-1)!.end;
              const labels = new Set(covering.map((s) => s.label));
              label = labels.size === 1 ? [...labels][0]! : null;
            }
          }
          const claimId = sha256(`${ctx.source.blob}\n${key}`).slice(0, 16);
          docs.push({
            id: claimId,
            doc: {
              schema: "claim-utterance-v1",
              claimId,
              operation: ctx.operation,
              rank,
              quote: q,
              claim: normalise(claim),
              speaker: speakerFor(label),
              date: ctx.record.publishedAt ?? null,
              location,
              source: ctx.source,
              prompt: ctx.prompt,
              model: ctx.model,
              createdAt: ctx.createdAt,
            },
          });
        });
        if (list.length > MAX_CLAIMS) rejected.push({ rank: MAX_CLAIMS + 1, reason: "over-limit" });
        return { docs, rejected, warnings };
      },
      label: (doc) => doc.quote,
    },
    ref,
    {
      repo: options.repo,
      model: options.model,
      modelId: options.modelId ?? DEFAULT_CLAIM_MODEL,
      branch: options.branch,
      now: options.now,
      // Segment ranges, times and speakers come from transcript.raw: a change to it is a new operation.
      identityExtra: raw ? `transcript.raw@${raw.blob}` : undefined,
    },
  );
  const { items, ...rest } = result;
  return { ...rest, claims: items.map((i) => ({ claimId: i.id, quote: i.label, path: i.path })) };
}

export type { ArticleRecord, SourceRef };
