import { z } from "zod";

/**
 * Conservative frequency assessment for one claim family (#404).
 *
 * The question is whether a claim's *rate* among analysed posts changed, not
 * whether the number of matched posts grew: a growing archive raises raw
 * counts while the rate stays flat, and that must never be reported as a
 * trend. Only an observed rate change over comparable, fully specified
 * coverage is asserted; everything else returns an explicit limitation.
 *
 * This is a deterministic projection over a pinned period result. It makes no
 * model call, no causal claim and no statement about prevalence beyond the
 * analysed posts.
 */

export const FrequencyPeriodSchema = z
  .object({
    /** Period label as declared by the caller, e.g. "2026-Q1". */
    period: z.string().min(1).max(40),
    /** Distinct posts in the analysed corpus that contain the family. */
    matchedPosts: z.number().int().min(0),
    /** Raw distinct occurrences, which is not comparable across coverage. */
    distinctOccurrences: z.number().int().min(0),
    /** Posts analysed in this period: the denominator for the rate. */
    analysedPosts: z.number().int().min(1),
  })
  .strict();
export type FrequencyPeriod = z.infer<typeof FrequencyPeriodSchema>;

export const FrequencyInputSchema = z
  .object({
    /** Declared scope, e.g. "collected posts from this publication". */
    scope: z.string().min(1).max(400),
    window: z.object({ from: z.string().min(1), to: z.string().min(1) }).strict(),
    periods: z.array(FrequencyPeriodSchema).min(1).max(60),
    /** Whether extraction coverage over the whole window is known to be complete. */
    coverage: z.enum(["known", "unknown"]),
    /** True when the underlying result was truncated by a read or result bound. */
    truncated: z.boolean().default(false),
    /** True when a material share of posts carry no usable date. */
    datesSparse: z.boolean().default(false),
    /** Smallest denominator the caller considers sufficient to speak about. */
    minimumAnalysedPosts: z.number().int().min(1).default(20),
    /**
     * Rate change, in absolute proportion points, that must be observed before
     * an increase or decrease is asserted. Named and recorded, never implicit.
     */
    minimumRateDelta: z.number().min(0).max(1).default(0.05),
  })
  .strict();
export type FrequencyInput = z.input<typeof FrequencyInputSchema>;

export interface FrequencyObservation extends FrequencyPeriod {
  /** matchedPosts / analysedPosts, rounded to four places. */
  rate: number;
}

export type FrequencyAssessment =
  | {
      kind: "no-assessment";
      scope: string;
      window: { from: string; to: string };
      reasons: string[];
      observations: FrequencyObservation[];
      limitations: string[];
    }
  | {
      kind: "observed";
      scope: string;
      window: { from: string; to: string };
      direction: "increase" | "decrease" | "flat";
      observations: FrequencyObservation[];
      /** Named thresholds the assessment relies on. */
      thresholds: { minimumAnalysedPosts: number; minimumRateDelta: number };
      statement: string;
      limitations: string[];
    };

const LIMITATION =
  "Observed among the analysed posts only; this is not prevalence across the publication, movement or internet.";

function rate(matchedPosts: number, analysedPosts: number): number {
  return Math.round((matchedPosts / analysedPosts) * 10_000) / 10_000;
}

/**
 * Assess one claim family's observed rate across comparable periods.
 *
 * Returns `no-assessment` whenever the input cannot support any claim at all:
 * unknown coverage, a truncated result, sparse dates, a denominator below the
 * declared minimum, or fewer than two periods to compare.
 */
export function assessClaimFamilyFrequency(input: FrequencyInput): FrequencyAssessment {
  const f = FrequencyInputSchema.parse(input);
  const observations: FrequencyObservation[] = f.periods.map((p) => ({
    ...p,
    rate: rate(p.matchedPosts, p.analysedPosts),
  }));
  const base = {
    scope: f.scope,
    window: f.window,
    observations,
  };
  const reasons: string[] = [];
  if (f.coverage === "unknown") reasons.push("extraction coverage over the window is unknown");
  if (f.truncated) reasons.push("the underlying period result was truncated");
  if (f.datesSparse) reasons.push("a material share of posts carry no usable date");
  if (f.periods.length < 2) reasons.push("fewer than two periods were supplied");
  const small = f.periods.filter((p) => p.analysedPosts < f.minimumAnalysedPosts);
  if (small.length > 0)
    reasons.push(
      `period(s) ${small.map((p) => p.period).join(", ")} analysed fewer than ${f.minimumAnalysedPosts} posts`,
    );

  if (reasons.length > 0) {
    return { kind: "no-assessment", ...base, reasons, limitations: [LIMITATION] };
  }

  // Compare the first and last period: the widest comparison the caller declared.
  const first = observations[0]!;
  const last = observations[observations.length - 1]!;
  const delta = Math.round((last.rate - first.rate) * 10_000) / 10_000;
  const direction: "increase" | "decrease" | "flat" =
    delta >= f.minimumRateDelta ? "increase" : delta <= -f.minimumRateDelta ? "decrease" : "flat";

  const statement =
    direction === "flat"
      ? `No change in observed rate for this claim family across ${f.scope}: ${first.period} ${first.matchedPosts}/${first.analysedPosts} (${first.rate}) versus ${last.period} ${last.matchedPosts}/${last.analysedPosts} (${last.rate}), inside the declared ${f.minimumRateDelta} threshold. Raw counts may differ because more posts were analysed.`
      : `Observed rate ${direction === "increase" ? "increase" : "decrease"} for this claim family across ${f.scope}: ${first.period} ${first.matchedPosts}/${first.analysedPosts} (${first.rate}) to ${last.period} ${last.matchedPosts}/${last.analysedPosts} (${last.rate}).`;

  return {
    kind: "observed",
    ...base,
    direction,
    thresholds: {
      minimumAnalysedPosts: f.minimumAnalysedPosts,
      minimumRateDelta: f.minimumRateDelta,
    },
    statement,
    limitations: [LIMITATION],
  };
}

/** Readable report: exact counts, the denominator, thresholds and limitations. */
export function renderFrequencyReport(a: FrequencyAssessment): string {
  const lines = [
    `Claim-family frequency: ${a.scope}`,
    `Window: ${a.window.from} to ${a.window.to}`,
    "",
    "period\tmatchedPosts\tanalysedPosts\trate\tdistinctOccurrences",
    ...a.observations.map(
      (o) => `${o.period}\t${o.matchedPosts}\t${o.analysedPosts}\t${o.rate}\t${o.distinctOccurrences}`,
    ),
    "",
    a.kind === "observed" ? a.statement : "No assessment: the input cannot support a claim.",
  ];
  if (a.kind === "no-assessment") {
    lines.push("", "Reasons:", ...a.reasons.map((r) => `- ${r}`));
  } else {
    lines.push(
      "",
      `Thresholds: at least ${a.thresholds.minimumAnalysedPosts} analysed posts per period; rate change of ${a.thresholds.minimumRateDelta}.`,
    );
  }
  lines.push("", "Limitations:", ...a.limitations.map((l) => `- ${l}`));
  return `${lines.join("\n")}\n`;
}
