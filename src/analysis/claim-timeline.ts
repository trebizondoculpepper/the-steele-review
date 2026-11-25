import { z } from "zod";
import {
  MAX_SEARCH_RESULTS,
  type SearchHit,
} from "../controllers/elasticsearch.js";
import {
  CLAIM_OCCURRENCE_INDEX_V1,
  ClaimOccurrenceSchema,
  claimIdentityKey,
  normalisedClaimKey,
  type ClaimOccurrence,
} from "./claim-occurrence.js";

/**
 * Observed claim timelines and speaker frequency (#81).
 *
 * A query over the claim-occurrence index (#80), never another
 * authoritative store. Results describe only what the collected corpus
 * contains: earliest and latest are earliest and latest *observed*, not when
 * a claim was first made. Unknown speakers and missing publication dates are
 * reported as such; nothing is attributed or dated automatically.
 *
 * Occurrence counts and distinct-post counts are separate, and both are
 * computed over unique occurrence IDs, so repeated processing never inflates
 * them. Results are bounded; a bounded result says it is truncated.
 */

export const TimelineFilterSchema = z
  .object({
    /** One of: a grouping key, a claim ID, or a statement to normalise into a grouping key. */
    groupingKey: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    claimId: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    statement: z.string().trim().min(1).max(2000).optional(),
    theme: z.string().min(1).max(60).optional(),
    publicationId: z.string().min(1).max(200).optional(),
    speakerName: z.string().trim().min(1).max(200).optional(),
    speakerKind: z
      .enum(["author-voice", "quoted", "unknown", "uncertain"])
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    bucket: z.enum(["month", "year"]).default("month"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_RESULTS)
      .default(MAX_SEARCH_RESULTS),
  })
  .strict()
  .refine(
    (f) => [f.groupingKey, f.claimId, f.statement, f.theme].some(Boolean),
    {
      message: "a claim, grouping, statement or theme is required",
    },
  )
  .refine((f) => !f.from || !f.to || Date.parse(f.from) <= Date.parse(f.to), {
    message: "from must not be after to",
  });
export type TimelineFilter = z.input<typeof TimelineFilterSchema>;

export interface OccurrenceSearchPort {
  search(
    index: string,
    query: unknown,
    options: { size?: number; sort?: unknown },
  ): Promise<SearchHit[]>;
}

export interface TimelineOccurrence {
  occurrenceId: string;
  publicationId: string;
  postId: string;
  url: string;
  /** Observed post publication time; absent when unknown. */
  sourcePublishedAt?: string;
  statement: string;
  passage: string;
  speaker: ClaimOccurrence["speaker"];
  artifact: ClaimOccurrence["artifact"];
  span: ClaimOccurrence["span"];
}

export interface ClaimTimeline {
  occurrenceCount: number;
  distinctPostCount: number;
  earliestObserved?: TimelineOccurrence;
  latestObserved?: TimelineOccurrence;
  /** Dated occurrences grouped by bucket (UTC), oldest first. */
  buckets: Array<{
    bucket: string;
    occurrences: number;
    distinctPosts: number;
  }>;
  undatedOccurrences: number;
  speakers: Array<{
    kind: string;
    name?: string;
    occurrences: number;
    distinctPosts: number;
  }>;
  occurrences: TimelineOccurrence[];
  invalidDocuments: number;
  truncated: boolean;
  caveat: string;
}

export const COVERAGE_CAVEAT =
  "Observed in the collected corpus only: dates are post publication dates, not when a claim was first made, and absence from a period means only that nothing collected contains it.";

export async function queryClaimTimeline(
  search: OccurrenceSearchPort,
  input: TimelineFilter,
  index = CLAIM_OCCURRENCE_INDEX_V1,
): Promise<ClaimTimeline> {
  const f = TimelineFilterSchema.parse(input);
  const filter: unknown[] = [];
  if (f.groupingKey) filter.push({ term: { "grouping.key": f.groupingKey } });
  // Match both grouping versions: v1 (loose text key) and v2 (strict key).
  if (f.statement) {
    filter.push({
      terms: {
        "grouping.key": [
          normalisedClaimKey(f.statement),
          claimIdentityKey(f.statement),
        ],
      },
    });
  }
  if (f.claimId) filter.push({ term: { claimId: f.claimId } });
  if (f.theme) filter.push({ term: { themes: f.theme } });
  if (f.publicationId)
    filter.push({ term: { publicationId: f.publicationId } });
  if (f.speakerName) filter.push({ term: { "speaker.name": f.speakerName } });
  if (f.speakerKind) filter.push({ term: { "speaker.kind": f.speakerKind } });
  // A date range excludes undated posts by definition; without one they stay in.
  if (f.from || f.to) {
    filter.push({
      range: {
        sourcePublishedAt: {
          ...(f.from ? { gte: f.from } : {}),
          ...(f.to ? { lte: f.to } : {}),
        },
      },
    });
  }
  const hits = await search.search(
    index,
    { bool: { filter } },
    {
      size: f.limit,
      sort: [
        { sourcePublishedAt: { order: "asc", missing: "_last" } },
        { occurrenceId: "asc" },
      ],
    },
  );

  const byId = new Map<string, ClaimOccurrence>();
  let invalidDocuments = 0;
  for (const hit of hits) {
    const parsed = ClaimOccurrenceSchema.safeParse(hit.source);
    if (!parsed.success) {
      invalidDocuments++;
      continue;
    }
    byId.set(parsed.data.occurrenceId, parsed.data);
  }
  const occurrences = [...byId.values()]
    .map(toTimelineOccurrence)
    .sort(compareObserved);
  const dated = occurrences.filter((o) => o.sourcePublishedAt);

  const buckets = new Map<
    string,
    { occurrences: number; posts: Set<string> }
  >();
  for (const o of dated) {
    // Buckets are UTC regardless of the stored offset.
    const key = new Date(o.sourcePublishedAt!)
      .toISOString()
      .slice(0, f.bucket === "year" ? 4 : 7);
    const b = buckets.get(key) ?? { occurrences: 0, posts: new Set<string>() };
    b.occurrences++;
    b.posts.add(postKey(o));
    buckets.set(key, b);
  }
  const speakers = new Map<
    string,
    { kind: string; name?: string; occurrences: number; posts: Set<string> }
  >();
  for (const o of occurrences) {
    const key = JSON.stringify([o.speaker.kind, o.speaker.name ?? null]);
    const s = speakers.get(key) ?? {
      kind: o.speaker.kind,
      ...(o.speaker.name ? { name: o.speaker.name } : {}),
      occurrences: 0,
      posts: new Set<string>(),
    };
    s.occurrences++;
    s.posts.add(postKey(o));
    speakers.set(key, s);
  }

  return {
    occurrenceCount: occurrences.length,
    distinctPostCount: new Set(occurrences.map(postKey)).size,
    ...(dated[0] ? { earliestObserved: dated[0] } : {}),
    ...(dated.length ? { latestObserved: dated[dated.length - 1] } : {}),
    buckets: [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, b]) => ({
        bucket,
        occurrences: b.occurrences,
        distinctPosts: b.posts.size,
      })),
    undatedOccurrences: occurrences.length - dated.length,
    speakers: [...speakers.values()]
      .sort(
        (a, b) => b.occurrences - a.occurrences || a.kind.localeCompare(b.kind),
      )
      .map(({ posts, ...s }) => ({ ...s, distinctPosts: posts.size })),
    occurrences,
    invalidDocuments,
    truncated: hits.length >= f.limit,
    caveat: COVERAGE_CAVEAT,
  };
}

const postKey = (o: TimelineOccurrence) => `${o.publicationId}/${o.postId}`;

function compareObserved(a: TimelineOccurrence, b: TimelineOccurrence): number {
  if (a.sourcePublishedAt && b.sourcePublishedAt) {
    return (
      Date.parse(a.sourcePublishedAt) - Date.parse(b.sourcePublishedAt) ||
      a.occurrenceId.localeCompare(b.occurrenceId)
    );
  }
  if (a.sourcePublishedAt) return -1;
  if (b.sourcePublishedAt) return 1;
  return a.occurrenceId.localeCompare(b.occurrenceId);
}

function toTimelineOccurrence(o: ClaimOccurrence): TimelineOccurrence {
  return {
    occurrenceId: o.occurrenceId,
    publicationId: o.publicationId,
    postId: o.postId,
    url: o.url,
    ...(o.sourcePublishedAt ? { sourcePublishedAt: o.sourcePublishedAt } : {}),
    statement: o.statement,
    passage: o.passage,
    speaker: o.speaker,
    artifact: o.artifact,
    span: o.span,
  };
}

const speakerLabel = (s: { kind: string; name?: string }) =>
  s.kind === "unknown"
    ? "unknown speaker"
    : s.name
      ? `${s.name} (${s.kind})`
      : `unnamed (${s.kind})`;

/** Readable plain-text report of a timeline. */
export function renderTimelineReport(t: ClaimTimeline): string {
  const lines = [
    `Occurrences: ${t.occurrenceCount} in ${t.distinctPostCount} distinct post(s)${t.truncated ? " (truncated: more may exist)" : ""}`,
    `Earliest observed: ${t.earliestObserved ? `${t.earliestObserved.sourcePublishedAt} ${t.earliestObserved.url}` : "none dated"}`,
    `Latest observed: ${t.latestObserved ? `${t.latestObserved.sourcePublishedAt} ${t.latestObserved.url}` : "none dated"}`,
    `Undated occurrences: ${t.undatedOccurrences}`,
    "",
    "By period:",
    ...(t.buckets.length
      ? t.buckets.map(
          (b) =>
            `  ${b.bucket}  ${b.occurrences} occurrence(s), ${b.distinctPosts} post(s)`,
        )
      : ["  (none dated)"]),
    "",
    "By speaker:",
    ...t.speakers.map(
      (s) =>
        `  ${speakerLabel(s)}  ${s.occurrences} occurrence(s), ${s.distinctPosts} post(s)`,
    ),
    "",
    "Occurrences:",
    ...t.occurrences.map(
      (o) =>
        `  ${o.sourcePublishedAt ?? "date unknown"}  ${speakerLabel(o.speaker)}  ${o.url}\n    "${o.passage}"\n    ${o.artifact.repository}@${o.artifact.commit.slice(0, 12)}:${o.artifact.path} [${o.span.start},${o.span.end})`,
    ),
    "",
    `Note: ${t.caveat}`,
  ];
  if (t.invalidDocuments)
    lines.push(
      `Skipped ${t.invalidDocuments} document(s) that do not match the occurrence contract.`,
    );
  return lines.join("\n");
}
