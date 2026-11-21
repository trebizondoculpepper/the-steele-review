import { randomBytes } from "node:crypto";
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
import {
  collapse,
  speakerFilter,
  verifiedSpeaker,
  type VerifiedSpeaker,
} from "./same-speaker-history.js";

/**
 * Specific claim parallels across speakers (#371).
 *
 * Extends the same-speaker retrieval (#368) to other verified speakers in the
 * corpus, with the same matching criteria: the same specific proposition or
 * argumentative move, never topic overlap. Each parallel keeps the exact
 * quote, attribution, date, source link and pinned revision, and says whether
 * the account agrees or diverges.
 *
 * - Parallels are reported as parallels. A parallel is marked `cites` only
 *   when the candidate passage itself credits or quotes the current speaker
 *   by name, verbatim; similarity never establishes borrowing.
 * - Nothing is double counted: passages identical to the current passage
 *   (a repost or quotation of it under another name) are excluded, identical
 *   passages across posts collapse to the earliest, and each other speaker
 *   contributes at most one parallel.
 * - Undated candidates are counted, not returned, because the reader is
 *   shown dates. No claim is judged true or false.
 */

export const DEFAULT_PARALLEL_PROMPT: ExtractionPrompt = {
  version: "cross-speaker-parallel-v1",
  instructions: readFileSync(
    new URL("../prompts/librarian/cross-speaker-parallel.md", import.meta.url),
    "utf8",
  ).trim(),
};

export const MAX_PARALLELS = 10;
export const MAX_PARALLEL_CANDIDATES = 30;

export interface CrossSpeakerParallel {
  occurrenceId: string;
  postId: string;
  publicationId: string;
  url: string;
  publishedAt: string;
  speaker: VerifiedSpeaker;
  quote: string;
  relation: "agrees" | "diverges";
  /** `cites` only with a verbatim credit of the current speaker; otherwise a parallel. */
  attribution: "parallel" | "cites";
  citationQuote?: string;
  /** Generated; not evidence. */
  difference: string;
  passage: string;
  span: { start: number; end: number };
  artifact: ArtifactReference;
  sourceVersion: string;
}

export interface CrossSpeakerResult {
  outcome: "parallels" | "no-match" | "no-candidates" | "speaker-unverified" | "failed";
  speaker?: VerifiedSpeaker;
  parallels: CrossSpeakerParallel[];
  diagnostics: {
    candidates: number;
    excludedUndated: number;
    excludedReposts: number;
    excludedSameSpeaker: number;
    rejectedByModel: number;
    invalidDocuments: number;
    modelVersion?: string;
    promptVersion?: string;
    note: string;
  };
}

export const PARALLEL_NOTE =
  "Parallels show that different speakers made the same claim; they do not show who originated it, or that either is true.";

const ModelSchema = z.object({
  parallels: z
    .array(
      z.object({
        candidate: z.string().min(1),
        quote: z.string().trim().min(1).max(2000),
        relation: z.enum(["agrees", "diverges"]),
        difference: z.string().trim().min(1).max(1000),
        citationQuote: z.string().trim().min(1).max(1000).optional(),
        confidence: z.enum(["high", "medium", "low"]),
      }),
    )
    .max(MAX_PARALLEL_CANDIDATES),
});

const sameName = (a: string, b: string) => collapse(a).toLowerCase() === collapse(b).toLowerCase();

export async function findCrossSpeakerParallels(input: {
  search: OccurrenceSearchPort;
  occurrence: ClaimOccurrence;
  provider: ExtractionModelProvider;
  prompt?: ExtractionPrompt;
  limit?: number;
  index?: string;
  signal?: AbortSignal;
}): Promise<CrossSpeakerResult> {
  const current = ClaimOccurrenceSchema.parse(input.occurrence);
  const prompt = input.prompt ?? DEFAULT_PARALLEL_PROMPT;
  const limit = Math.min(input.limit ?? MAX_PARALLELS, MAX_PARALLELS);
  const diagnostics: CrossSpeakerResult["diagnostics"] = {
    candidates: 0,
    excludedUndated: 0,
    excludedReposts: 0,
    excludedSameSpeaker: 0,
    rejectedByModel: 0,
    invalidDocuments: 0,
    note: PARALLEL_NOTE,
  };
  // Without a verified speaker, "another speaker" cannot be established.
  const speaker = verifiedSpeaker(current);
  if (!speaker) return { outcome: "speaker-unverified", parallels: [], diagnostics };

  const hits = await input.search.search(
    input.index ?? CLAIM_OCCURRENCE_INDEX_V1,
    {
      bool: {
        must_not: [speakerFilter(speaker), { term: { postId: current.postId } }],
        should: [
          { term: { "grouping.key": current.grouping.key } },
          { match: { statement: current.statement } },
          { match: { passage: current.statement } },
        ],
        minimum_should_match: 1,
      },
    },
    { size: MAX_PARALLEL_CANDIDATES },
  );

  const currentPassage = collapse(current.passage).toLowerCase();
  const byPassage = new Map<string, { o: ClaimOccurrence; speaker: VerifiedSpeaker }>();
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
    const other = verifiedSpeaker(o);
    if (!other) continue; // an unattributed passage cannot be a speaker's parallel
    if (sameName(other.name, speaker.name)) {
      diagnostics.excludedSameSpeaker++;
      continue;
    }
    const key = collapse(o.passage).toLowerCase();
    if (key === currentPassage) {
      // The current passage repeated under another name: not a parallel.
      diagnostics.excludedReposts++;
      continue;
    }
    if (!o.sourcePublishedAt) {
      diagnostics.excludedUndated++;
      continue;
    }
    const prior = byPassage.get(key);
    if (prior) {
      diagnostics.excludedReposts++;
      if (Date.parse(o.sourcePublishedAt) < Date.parse(prior.o.sourcePublishedAt!)) {
        byPassage.set(key, { o, speaker: other });
      }
      continue;
    }
    byPassage.set(key, { o, speaker: other });
  }
  const candidates = [...byPassage.values()];
  diagnostics.candidates = candidates.length;
  if (candidates.length === 0) {
    return { outcome: "no-candidates", speaker, parallels: [], diagnostics };
  }

  diagnostics.modelVersion = input.provider.modelVersion;
  diagnostics.promptVersion = prompt.version;
  const ids = new Map(candidates.map((c, i) => [`c${i + 1}`, c]));
  const boundary = `DATA-${randomBytes(12).toString("hex")}`;
  const user = [
    `Boundary: ${boundary}`,
    boundary,
    JSON.stringify({
      current: { speaker: speaker.name, statement: current.statement, passage: current.passage },
      candidates: [...ids].map(([id, c]) => ({
        id,
        speaker: c.speaker.name,
        publishedAt: c.o.sourcePublishedAt,
        statement: c.o.statement,
        passage: c.o.passage,
      })),
    }),
    boundary,
  ].join("\n");
  let output: z.infer<typeof ModelSchema>;
  try {
    const raw = await input.provider.complete(
      { system: prompt.instructions, user, maxOutputChars: 12_000 },
      input.signal ?? new AbortController().signal,
    );
    output = ModelSchema.parse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
  } catch {
    diagnostics.rejectedByModel = candidates.length;
    return { outcome: "failed", speaker, parallels: [], diagnostics };
  }

  const bySpeaker = new Map<string, CrossSpeakerParallel>();
  let accepted = 0;
  for (const p of output.parallels) {
    const c = ids.get(p.candidate);
    const quote = collapse(p.quote);
    if (!c || p.confidence !== "high" || !quote || !collapse(c.o.passage).includes(quote)) continue;
    // Borrowing needs the candidate's own verbatim credit naming the speaker.
    const citation =
      p.citationQuote &&
      collapse(c.o.passage).includes(collapse(p.citationQuote)) &&
      collapse(p.citationQuote).toLowerCase().includes(speaker.name.toLowerCase())
        ? collapse(p.citationQuote)
        : undefined;
    const parallel: CrossSpeakerParallel = {
      occurrenceId: c.o.occurrenceId,
      postId: c.o.postId,
      publicationId: c.o.publicationId,
      url: c.o.url,
      publishedAt: c.o.sourcePublishedAt!,
      speaker: c.speaker,
      quote,
      relation: p.relation,
      attribution: citation ? "cites" : "parallel",
      ...(citation ? { citationQuote: citation } : {}),
      difference: p.difference,
      passage: c.o.passage,
      span: c.o.span,
      artifact: c.o.artifact,
      sourceVersion: c.o.sourceVersion,
    };
    // One parallel per other speaker: the earliest dated account.
    const name = c.speaker.name.toLowerCase();
    const prior = bySpeaker.get(name);
    if (!prior) accepted++;
    if (!prior || Date.parse(parallel.publishedAt) < Date.parse(prior.publishedAt)) {
      bySpeaker.set(name, parallel);
    }
  }
  diagnostics.rejectedByModel = candidates.length - accepted;
  const parallels = [...bySpeaker.values()]
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
    .slice(0, limit);
  return {
    outcome: parallels.length ? "parallels" : "no-match",
    speaker,
    parallels,
    diagnostics,
  };
}
