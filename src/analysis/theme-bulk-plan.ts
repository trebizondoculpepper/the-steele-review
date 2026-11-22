import { z } from "zod";

/**
 * Theme-only bulk analysis plan (#526).
 *
 * A bulk pass ranks how often themes recur so research can be prepared for the
 * common ones ahead of individual article runs. This module plans that pass and
 * ranks its output; it never runs claims, research, drafting or publishing, and
 * it does not itself call a model.
 *
 * Saved extractions are only reusable when they are readable and were produced
 * by the same processor identity (model and prompt versions) as the current
 * one. A historical count is never treated as proof of current completeness.
 */

export const BulkPostSchema = z
  .object({ publicationId: z.string().min(1), postId: z.string().min(1) })
  .strict();
export type BulkPost = z.infer<typeof BulkPostSchema>;

export const ProcessorIdentitySchema = z
  .object({ modelVersion: z.string().min(1), promptVersion: z.string().min(1) })
  .strict();
export type ProcessorIdentity = z.infer<typeof ProcessorIdentitySchema>;

export interface SavedThemeExtraction {
  /** Exact source revision the saved result was produced from. */
  sourceVersion: string;
  processor: ProcessorIdentity;
  /** False when the saved result could not be read or parsed. */
  readable: boolean;
  /** Proposed theme titles, exactly as saved. */
  titles: string[];
}

export type BulkAction = "reuse" | "extract" | "incompatible";

export interface BulkPlanEntry extends BulkPost {
  action: BulkAction;
  reason: string;
}

export interface BulkPlan {
  entries: BulkPlanEntry[];
  counts: { reuse: number; extract: number; incompatible: number };
  /** True when the requested selection exceeds the plan bound. */
  truncated: boolean;
}

export interface BulkPlanInput {
  selection: BulkPost[];
  /** Saved extraction per `publicationId/postId`. */
  saved: Map<string, SavedThemeExtraction>;
  /** Current processor identity; results from another identity are incompatible. */
  current: ProcessorIdentity;
  /** How many posts one pass may handle. */
  limit?: number;
}

export const DEFAULT_BULK_LIMIT = 1000;

const key = (post: BulkPost) => `${post.publicationId}/${post.postId}`;

/**
 * Decide, per selected post, whether a saved theme result can be reused, must be
 * extracted, or is incompatible with the current processor.
 */
export function planThemeBulk(input: BulkPlanInput): BulkPlan {
  const limit = input.limit ?? DEFAULT_BULK_LIMIT;
  const selection = input.selection.slice(0, limit);
  const entries: BulkPlanEntry[] = selection.map((post) => {
    const saved = input.saved.get(key(post));
    if (!saved)
      return { ...post, action: "extract", reason: "no saved theme result for this post" };
    if (!saved.readable)
      return { ...post, action: "extract", reason: "saved theme result is unreadable" };
    if (
      saved.processor.modelVersion !== input.current.modelVersion ||
      saved.processor.promptVersion !== input.current.promptVersion
    )
      return {
        ...post,
        action: "incompatible",
        reason: "saved result came from a different model or prompt version",
      };
    return { ...post, action: "reuse", reason: "saved result matches the current processor" };
  });
  const counts = { reuse: 0, extract: 0, incompatible: 0 };
  for (const e of entries) counts[e.action] += 1;
  return { entries, counts, truncated: input.selection.length > limit };
}

/** Normalise a proposed theme title for frequency counting. */
export function normaliseThemeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface ThemeFrequency {
  /** Normalised title used for grouping. */
  key: string;
  /** Every distinct saved wording for this theme, most common first. */
  titles: string[];
  /** Distinct posts proposing it; repetitions within one post count once. */
  postCount: number;
}

/**
 * Rank themes by how many distinct posts propose them.
 *
 * Counting posts rather than proposals keeps a single verbose post from
 * dominating the ranking, and every saved wording is retained so a human can
 * see what the extractor actually produced.
 */
export function rankThemeFrequency(results: SavedThemeExtraction[]): ThemeFrequency[] {
  const byTheme = new Map<string, { titles: Map<string, number>; posts: Set<number> }>();
  results.forEach((result, index) => {
    if (!result.readable) return;
    for (const title of result.titles) {
      const k = normaliseThemeTitle(title);
      if (k === "") continue;
      const entry = byTheme.get(k) ?? { titles: new Map<string, number>(), posts: new Set<number>() };
      entry.titles.set(title, (entry.titles.get(title) ?? 0) + 1);
      entry.posts.add(index);
      byTheme.set(k, entry);
    }
  });
  return [...byTheme.entries()]
    .map(([k, entry]) => ({
      key: k,
      titles: [...entry.titles.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
      postCount: entry.posts.size,
    }))
    .sort((a, b) => b.postCount - a.postCount || a.key.localeCompare(b.key));
}
