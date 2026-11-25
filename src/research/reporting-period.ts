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

export const PERIOD_NOT_STATED =
  "excluded: the claim's figure depends on a reporting period the source does not state";

/** The reason a claim is left out of research, or undefined when it is eligible. */
export function reportingPeriodExclusion(claim: unknown): string | undefined {
  const parsed = ClaimShape.safeParse(claim);
  if (!parsed.success) return undefined;
  const period = parsed.data.reportingPeriod;
  return period?.dependsOnPeriod && !period.text
    ? PERIOD_NOT_STATED
    : undefined;
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
  if (reportingPeriod)
    return reportingPeriod.dependsOnPeriod && reportingPeriod.text
      ? { period: reportingPeriod.text }
      : undefined;
  // A standalone number, other than a bare year, is a figure.
  const figure = [...statement.matchAll(/(?<![\w.])\d[\d,.]*(?![\w])/g)].some(
    (m) => !/^(1[5-9]|20)\d{2}$/.test(m[0].replace(/[.,]+$/, "")),
  );
  const resolved = (dates ?? []).some((d) => !!d.value);
  return figure && !resolved ? "occurrence-only" : undefined;
}
