import { z } from "zod";
import { ReportingPeriodSchema } from "../analysis/claim.js";

/**
 * Reporting periods and research (#889).
 *
 * Owner decision: a quantitative claim whose figure depends on a reporting
 * period is researched only when the source itself states that period.
 * Otherwise it is left out of the eligible research set, with the reason
 * recorded, and no period is inferred. When the period is stated, it is part
 * of the claim's research identity, so different periods never share research.
 *
 * Older stored claims have no reporting-period field and stay readable. One
 * that states a standalone figure without a resolved date is not eligible for
 * shared research: it is still researched, but only for its own occurrence,
 * because nothing establishes its period. ("5G" and a bare year such as "2019" are not figures.)
 */
const ClaimShape = z.looseObject({
  statement: z.string(),
  dates: z.array(z.looseObject({ value: z.string().optional() })).optional(),
  reportingPeriod: ReportingPeriodSchema.optional(),
});

export const PERIOD_NOT_ANCHORED =
  "excluded: the claim's reporting period is relative (for example 'last year') and the source does not anchor it to a year";
export const PERIOD_NOT_STATED =
  "excluded: the claim's figure depends on a reporting period the source does not state";

/** The reason a claim is left out of research, or undefined when it is eligible. */
export function reportingPeriodExclusion(claim: unknown): string | undefined {
  const parsed = ClaimShape.safeParse(claim);
  if (!parsed.success) return undefined;
  const period = parsed.data.reportingPeriod;
  if (!period?.dependsOnPeriod) return undefined;
  if (!period.text) return PERIOD_NOT_STATED;
  // A relative period is not established without a year: never inferred.
  return fullySpecified(period.text) ? undefined : PERIOD_NOT_ANCHORED;
}

/**
 * How the reporting period bears on shared research identity: the stated
 * period wording to include in it, or "occurrence-only" for an older claim
 * whose period cannot be established.
 */
export function reportingPeriodIdentity(
  claim: unknown,
): { period: string } | "occurrence-only" | undefined {
  const parsed = ClaimShape.safeParse(claim);
  if (!parsed.success) return undefined;
  const { reportingPeriod, statement, dates } = parsed.data;
  if (reportingPeriod) {
    if (!reportingPeriod.dependsOnPeriod || !reportingPeriod.text)
      return undefined;
    // "last year" or "this quarter" means different periods in different
    // posts: only a period anchored to an explicit year is shared.
    return fullySpecified(reportingPeriod.text)
      ? { period: reportingPeriod.text }
      : "occurrence-only";
  }
  // A standalone number, other than a bare year, is a figure.
  // A standalone number is a figure unless it is a bare calendar year; an
  // amount with a currency symbol is always a figure ("$2026").
  const figure = [
    ...statement.matchAll(/(?<![\w.])([$£€¥])?\s?(\d[\d,.]*)(?![\w])/g),
  ].some(
    (m) => !!m[1] || !/^(1[5-9]|20)\d{2}$/.test(m[2]!.replace(/[.,]+$/, "")),
  );
  const resolved = (dates ?? []).some((d) => !!d.value);
  return figure && !resolved ? "occurrence-only" : undefined;
}

/**
 * A period wording anchored to an explicit year ("Q3 2026", "FY2026", "the
 * last quarter of 2025"). Relative wording is fine once a year anchors it;
 * without one ("last year", "Q3") the period is not established.
 */
function fullySpecified(text: string): boolean {
  return /(?<!\d)(1[5-9]|20)\d{2}(?!\d)/.test(text);
}

/**
 * The statement research is asked about (#889). For a new claim whose figure
 * depends on a stated period, the period is appended, so the researcher and
 * the support judge evaluate it for that period and the job identity differs
 * per period. Relative periods ("last year") are excluded before research,
 * because nothing anchors them to a year. Older claims, and
 * claims that do not depend on a period, are unchanged.
 */
export function researchStatement(
  statement: string,
  claim: unknown,
  post?: { publicationId: string; postId: string },
): string {
  const parsed = ClaimShape.safeParse(claim);
  const period = parsed.success ? parsed.data.reportingPeriod : undefined;
  if (!period?.dependsOnPeriod || !period.text) return statement;
  // Relative periods never reach research: they are excluded as not anchored.
  void post;
  return `${statement} [reporting period: ${period.text}]`;
}
