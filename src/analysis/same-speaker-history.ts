import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ArtifactReference } from "../content/artifact-reference.js";
import {
  CLAIM_OCCURRENCE_INDEX_V1,
  ClaimOccurrenceSchema,
  type ClaimOccurrence,
} from "./claim-occurrence.js";
import type { OccurrenceSearchPort } from "./claim-timeline.js";
import type { ExtractionModelProvider, ExtractionPrompt } from "./extraction.js";

/**
 * Earlier examples of a claim from the same speaker (#368).
 *
 * Given one claim occurrence in the current post revision, return a bounded,
 * ranked set of earlier passages in which the same verified speaker made the
 * same specific proposition or argumentative move.
 *
 * - Speaker identity comes only from the occurrence's own attribution: a
 *   named, evidenced speaker (`quoted` or `uncertain` with a name), or the
 *   post's named author when the post asserts the claim in its own voice.
 *   Publication identity is never treated as speaker identity, so a claim
 *   with no named speaker or author returns `speaker-unverified`.
 * - Candidates are read from the claim-occurrence index (#80), strictly
 *   before the current post's observed publication time and never from the
 *   current post. Undated candidates cannot be placed before it and are
 *   counted, not returned. Identical passages in different posts (reposts)
 *   are kept once, at their earliest observed date.
 * - A candidate with the same grouping key and an identical statement is
 *   accepted directly. Others are judged by the model, which must name
 *   offered candidates and confirm the same proposition, not the same topic;
 *   only high-confidence matches with a verbatim quote from the candidate's
 *   passage are kept.
 * - Every result carries the exact quotation, speaker attribution, date,
 *   source link and pinned artifact reference. No-match outcomes carry a
 *   diagnostic reason and counts. Nothing is judged true or false.
 */

export const DEFAULT_SAME_SPEAKER_PROMPT: ExtractionPrompt = {
  version: "same-speaker-match-v1",
  instructions: readFileSync(
    new URL("../prompts/librarian/same-speaker-match.md", import.meta.url),
    "utf8",
  ).trim(),
};

export const MAX_HISTORY = 10;
export const MAX_HISTORY_CANDIDATES = 30;

export const SPEAKER_HISTORY_NOTE =
  "Results reflect only the indexed claim occurrences; finding nothing does not show the speaker never made the claim.";

export type SpeakerBasis = "named-speaker" | "post-author";

export interface VerifiedSpeaker {
  name: string;
  basis: SpeakerBasis;
}

export interface SameSpeakerMatch {
  occurrenceId: string;
  postId: string;
  publicationId: string;
  url: string;
  publishedAt: string;
  speaker: VerifiedSpeaker;
  /** Exact text from the earlier passage. */
  quote: string;
  statement: string;
  /** The whole earlier passage and its offsets in the archived source text. */
  passage: string;
  span: { start: number; end: number };
  artifact: ArtifactReference;
  sourceVersion: string;
  /** `grouping` when the normalised assertion is identical; otherwise the model judged it. */
  matchedBy: "grouping" | "model";
  /** Generated; not evidence. */
  reason?: string;
}

export type SameSpeakerOutcome =
  | "matches"
  | "speaker-unverified"
  | "source-undated"
  | "no-candidates"
  | "no-match";

export interface SameSpeakerHistory {
  outcome: SameSpeakerOutcome;
  speaker?: VerifiedSpeaker;
  /** Oldest first. */
  matches: SameSpeakerMatch[];
  diagnostics: {
    candidates: number;
    excludedUndated: number;
    excludedReposts: number;
    rejectedByModel: number;
    invalidDocuments: number;
    modelVersion?: string;
    promptVersion?: string;
    note: string;
  };
}

const ModelOutputSchema = z.object({
  matches: z
    .array(
      z.object({
        candidate: z.string().min(1),
        quote: z.string().trim().min(1).max(2000),
        confidence: z.enum(["high", "medium", "low"]),
        reason: z.string().trim().min(1).max(1000),
      }),
    )
    .max(MAX_HISTORY_CANDIDATES),
});

/** The speaker an occurrence verifiably names, or undefined when it names none. */
export function verifiedSpeaker(o: ClaimOccurrence): VerifiedSpeaker | undefined {
  const { kind, name } = o.speaker;
  if ((kind === "quoted" || kind === "uncertain") && name && o.speaker.evidence) {
    return { name, basis: "named-speaker" };
  }
  if (kind === "author-voice" && o.publisher.author) {
    return { name: o.publisher.author, basis: "post-author" };
  }
  return undefined;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function speakerFilter(s: VerifiedSpeaker): unknown {
  // The same person may be quoted in one post and write in their own voice in
  // another, so both attributions of the name are searched.
  return {
    bool: {
      should: [
        {
          bool: {
            filter: [
              { terms: { "speaker.kind": ["quoted", "uncertain"] } },
              { term: { "speaker.name": s.name } },
            ],
          },
        },
        {
          bool: {
            filter: [
              { term: { "speaker.kind": "author-voice" } },
              { term: { "publisher.author": s.name } },
            ],
          },
        },
      ],
      minimum_should_match: 1,
    },
  };
}

export async function findSameSpeakerHistory(input: {
  search: OccurrenceSearchPort;
  /** The claim as it occurs in the current post revision. */
  occurrence: ClaimOccurrence;
  provider: ExtractionModelProvider;
  prompt?: ExtractionPrompt;
  limit?: number;
  index?: string;
  signal?: AbortSignal;
}): Promise<SameSpeakerHistory> {
  const current = ClaimOccurrenceSchema.parse(input.occurrence);
  const prompt = input.prompt ?? DEFAULT_SAME_SPEAKER_PROMPT;
  const limit = Math.min(input.limit ?? MAX_HISTORY, MAX_HISTORY);
  const index = input.index ?? CLAIM_OCCURRENCE_INDEX_V1;
  const diagnostics: SameSpeakerHistory["diagnostics"] = {
    candidates: 0,
    excludedUndated: 0,
    excludedReposts: 0,
    rejectedByModel: 0,
    invalidDocuments: 0,
    note: SPEAKER_HISTORY_NOTE,
  };
  const speaker = verifiedSpeaker(current);
  if (!speaker) return { outcome: "speaker-unverified", matches: [], diagnostics };
  if (!current.sourcePublishedAt) {
    return { outcome: "source-undated", speaker, matches: [], diagnostics };
  }
  const sourceTime = Date.parse(current.sourcePublishedAt);

  const hits = await input.search.search(
    index,
    {
      bool: {
        // The strict date bound is in the query, so later posts cannot use up
        // the candidate budget; undated posts are counted separately below.
        filter: [
          speakerFilter(speaker),
          { range: { sourcePublishedAt: { lt: current.sourcePublishedAt } } },
        ],
        // By post identity only: an earlier post with identical text (same source
        // hash) is still history, and reposts are collapsed below.
        must_not: [{ term: { postId: current.postId } }],
        should: [
          { term: { "grouping.key": current.grouping.key } },
          { match: { statement: current.statement } },
          { match: { passage: current.statement } },
        ],
        minimum_should_match: 1,
      },
    },
    { size: MAX_HISTORY_CANDIDATES },
  );

  try {
    const undated = await input.search.search(
      index,
      {
        bool: {
          filter: [speakerFilter(speaker), { term: { "grouping.key": current.grouping.key } }],
          must_not: [
            { exists: { field: "sourcePublishedAt" } },
            { term: { postId: current.postId } },
          ],
        },
      },
      { size: MAX_HISTORY_CANDIDATES },
    );
    diagnostics.excludedUndated = new Set(
      undated.map((h) => (h.source as { postId?: string }).postId),
    ).size;
  } catch {
    // Counting is best effort; the note still states the limitation.
  }

  // Parse, then keep strictly earlier, dated candidates; collapse reposts.
  const byPassage = new Map<string, ClaimOccurrence>();
  const seen = new Set<string>();
  for (const hit of hits) {
    const parsed = ClaimOccurrenceSchema.safeParse(hit.source);
    if (!parsed.success) {
      diagnostics.invalidDocuments++;
      continue;
    }
    const o = parsed.data;
    if (seen.has(o.occurrenceId) || o.postId === current.postId) continue;
    seen.add(o.occurrenceId);
    if (!o.sourcePublishedAt) continue; // counted above
    if (Date.parse(o.sourcePublishedAt) >= sourceTime) continue;
    const key = collapse(o.passage).toLowerCase();
    const prior = byPassage.get(key);
    if (prior) {
      diagnostics.excludedReposts++;
      if (Date.parse(o.sourcePublishedAt) < Date.parse(prior.sourcePublishedAt!)) {
        byPassage.set(key, o);
      }
      continue;
    }
    byPassage.set(key, o);
  }
  const candidates = [...byPassage.values()];
  diagnostics.candidates = candidates.length;
  if (candidates.length === 0) {
    return { outcome: "no-candidates", speaker, matches: [], diagnostics };
  }

  const toMatch = (
    o: ClaimOccurrence,
    quote: string,
    matchedBy: SameSpeakerMatch["matchedBy"],
    reason?: string,
  ): SameSpeakerMatch => ({
    occurrenceId: o.occurrenceId,
    postId: o.postId,
    publicationId: o.publicationId,
    url: o.url,
    publishedAt: o.sourcePublishedAt!,
    speaker: verifiedSpeaker(o) ?? speaker,
    quote,
    statement: o.statement,
    passage: o.passage,
    span: o.span,
    artifact: o.artifact,
    sourceVersion: o.sourceVersion,
    matchedBy,
    ...(reason ? { reason } : {}),
  });

  const matches: SameSpeakerMatch[] = [];
  const toJudge: ClaimOccurrence[] = [];
  for (const o of candidates) {
    // A shared grouping key is only a proposal (a loose key can merge "+2%" and
    // "-2%"), so only an identical statement skips the model.
    if (
      o.grouping.key === current.grouping.key &&
      collapse(o.statement) === collapse(current.statement)
    )
      matches.push(toMatch(o, o.passage, "grouping"));
    else toJudge.push(o);
  }

  if (toJudge.length > 0) {
    diagnostics.modelVersion = input.provider.modelVersion;
    diagnostics.promptVersion = prompt.version;
    const ids = new Map(toJudge.map((o, i) => [`c${i + 1}`, o]));
    const user = JSON.stringify({
      current: { statement: current.statement, passage: current.passage, speaker: speaker.name },
      candidates: [...ids].map(([id, o]) => ({
        id,
        publishedAt: o.sourcePublishedAt,
        statement: o.statement,
        passage: o.passage,
      })),
    });
    let output: z.infer<typeof ModelOutputSchema> = { matches: [] };
    try {
      const raw = await input.provider.complete(
        { system: prompt.instructions, user, maxOutputChars: 8000 },
        input.signal ?? new AbortController().signal,
      );
      const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      output = ModelOutputSchema.parse(JSON.parse(json));
    } catch {
      // An unusable model answer accepts nothing; the counts still report it.
      diagnostics.rejectedByModel = toJudge.length;
    }
    const accepted = new Set<string>();
    for (const m of output.matches) {
      const o = ids.get(m.candidate);
      const quote = collapse(m.quote);
      if (
        !o ||
        quote.length === 0 ||
        accepted.has(m.candidate) ||
        m.confidence !== "high" ||
        !collapse(o.passage).includes(quote)
      ) {
        continue;
      }
      accepted.add(m.candidate);
      matches.push(toMatch(o, quote, "model", m.reason));
    }
    if (diagnostics.rejectedByModel === 0)
      diagnostics.rejectedByModel = toJudge.length - accepted.size;
  }

  const ranked = matches
    .sort((a, b) =>
      a.matchedBy === b.matchedBy
        ? Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
        : a.matchedBy === "grouping"
          ? -1
          : 1,
    )
    .slice(0, limit)
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  return {
    outcome: ranked.length ? "matches" : "no-match",
    speaker,
    matches: ranked,
    diagnostics,
  };
}
