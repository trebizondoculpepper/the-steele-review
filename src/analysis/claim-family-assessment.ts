import type { ArtifactReference } from "../content/artifact-reference.js";
import {
  CorpusPeriodResultSchema,
  type CorpusPeriodResult,
} from "./corpus-periods.js";
import {
  assessClaimFamilyFrequency,
  type FrequencyAssessment,
  type FrequencyPeriod,
} from "./claim-family-frequency.js";

/**
 * Provenance-carrying frequency assessment (#404).
 *
 * `assessClaimFamilyFrequency` is arithmetic over caller-supplied counts. This
 * layer binds it to one pinned, validated `CorpusPeriodResult` (#403): it reads
 * the result through the artifact controller, keeps the exact reference, maps
 * every period (never silently dropping a zero-count month), and derives the
 * coverage, exclusion and completeness limitations from the result's own
 * diagnostics rather than trusting a caller's summary.
 */

/** Minimal artifact-controller read surface: verifies repository and content hash. */
export interface PinnedResultReader {
  read(ref: ArtifactReference): Promise<string>;
}

export interface PinnedFrequencyInput {
  artifacts: PinnedResultReader;
  /** The exact committed `CorpusPeriodResult` to assess. */
  result: ArtifactReference;
  minimumAnalysedPosts?: number;
  minimumRateDelta?: number;
}

export interface PinnedFrequencyAssessment {
  /** Exact input reference, retained so the report is reproducible. */
  input: ArtifactReference;
  family: string;
  scope: { description: string; publications: string[]; complete: boolean };
  window: { start: string; end: string };
  /** Every period in the result, in order, including empty months. */
  periods: Array<{
    month: string;
    matchedPosts: number;
    analysedPosts: number;
    rate: number;
    occurrences: number;
    excludedCopies: number;
  }>;
  /** Named exclusions and limitations to publish with the numbers. */
  exclusions: string[];
  limitations: string[];
  /** The arithmetic verdict, or a qualified no-assessment. */
  assessment: FrequencyAssessment;
}

const STANDING =
  "Observed among the analysed posts only; this is not prevalence across the publication, movement or internet.";

/**
 * Validate a period result and assess its family frequency without inventing
 * coverage. A zero `analysedPosts` month is preserved and makes the assessment
 * a `no-assessment`, never a silently skipped row.
 */
export async function assessPinnedCorpusPeriods(
  input: PinnedFrequencyInput,
): Promise<PinnedFrequencyAssessment> {
  const raw = await input.artifacts.read(input.result);
  const result: CorpusPeriodResult = CorpusPeriodResultSchema.parse(JSON.parse(raw));

  const periods = result.periods.map((p) => ({
    month: p.month,
    matchedPosts: p.matchedPosts,
    analysedPosts: p.analysedPosts,
    // Distinct occurrences are reported, never used as the rate.
    occurrences: p.occurrences,
    excludedCopies: p.excludedCopies,
    rate:
      p.analysedPosts === 0
        ? 0
        : Math.round((p.matchedPosts / p.analysedPosts) * 10_000) / 10_000,
  }));

  const limitations: string[] = [];
  const exclusions: string[] = [];
  // Extraction gaps are per period, not diagnostics: sum them without dropping any.
  // Per-period extraction gaps plus sources the projector could not read or
  // validate: all of them mean part of the archive contributed no counts.
  const missingCoverage =
    result.periods.reduce((n, p) => n + p.missingExtractions + p.invalidExtractions, 0) +
    result.diagnostics.unavailableSources +
    result.diagnostics.invalidSources;

  if (result.scope.complete)
    exclusions.push("the declared publication sample is complete for this scope");
  else limitations.push("the declared publication sample is not exhaustive of the scope");
  if (result.exactCopies === "exclude-identical-source")
    exclusions.push("identical-source copies were excluded from matched posts");
  const excludedCopies = result.periods.reduce((n, p) => n + p.excludedCopies, 0);
  if (excludedCopies > 0) exclusions.push(`${excludedCopies} identical-source copies excluded`);
  if (result.diagnostics.unknownDates > 0)
    limitations.push(
      `${result.diagnostics.unknownDates} posts have unknown dates and are outside the period counts`,
    );
  if (missingCoverage > 0)
    limitations.push(`${missingCoverage} archived posts have no usable extraction`);
  if (result.diagnostics.incompleteCaptures > 0)
    limitations.push(`${result.diagnostics.incompleteCaptures} captures are incomplete`);
  if (result.diagnostics.outsideWindow > 0)
    limitations.push(`${result.diagnostics.outsideWindow} posts fall outside the declared window`);
  if (result.truncated) limitations.push("the period result was truncated");
  for (const caveat of result.caveats) limitations.push(caveat);
  limitations.push(STANDING);

  const mapped: FrequencyPeriod[] = periods.map((p) => ({
    period: p.month,
    matchedPosts: p.matchedPosts,
    distinctOccurrences: p.occurrences,
    analysedPosts: p.analysedPosts,
  }));

  const assessment = assessClaimFamilyFrequency({
    scope: result.scope.description,
    window: { from: result.window.start, to: result.window.end },
    periods: mapped,
    // Completeness is derived from the result, never asserted by the caller.
    coverage:
      result.scope.complete &&
      !result.truncated &&
      missingCoverage === 0 &&
      result.diagnostics.unknownDates === 0
        ? "known"
        : "unknown",
    truncated: result.truncated,
    datesSparse: result.diagnostics.unknownDates > 0,
    ...(input.minimumAnalysedPosts === undefined
      ? {}
      : { minimumAnalysedPosts: input.minimumAnalysedPosts }),
    ...(input.minimumRateDelta === undefined
      ? {}
      : { minimumRateDelta: input.minimumRateDelta }),
  });

  return {
    input: input.result,
    family: result.family.name,
    scope: result.scope,
    window: result.window,
    periods,
    exclusions,
    limitations: [...new Set(limitations)],
    assessment,
  };
}

/** Readable report: exact input reference, periods, verdict, exclusions, limitations. */
export function renderPinnedFrequencyReport(a: PinnedFrequencyAssessment): string {
  const lines = [
    `Claim-family frequency: ${a.family}`,
    `Scope: ${a.scope.description}`,
    `Window: ${a.window.start} to ${a.window.end}`,
    `Input: ${a.input.repository}@${a.input.commit}:${a.input.path} (${a.input.hash})`,
    "",
    "month\tmatchedPosts\tanalysedPosts\trate\toccurrences\texcludedCopies",
    ...a.periods.map(
      (p) =>
        `${p.month}\t${p.matchedPosts}\t${p.analysedPosts}\t${p.rate}\t${p.occurrences}\t${p.excludedCopies}`,
    ),
    "",
    a.assessment.kind === "observed"
      ? a.assessment.statement
      : "No assessment: the input cannot support a claim.",
  ];
  if (a.assessment.kind === "no-assessment") {
    lines.push("", "Reasons:", ...a.assessment.reasons.map((r) => `- ${r}`));
  } else {
    lines.push(
      "",
      `Thresholds: at least ${a.assessment.thresholds.minimumAnalysedPosts} analysed posts per period; rate change of ${a.assessment.thresholds.minimumRateDelta}.`,
    );
  }
  if (a.exclusions.length > 0) lines.push("", "Exclusions:", ...a.exclusions.map((e) => `- ${e}`));
  lines.push("", "Limitations:", ...a.limitations.map((l) => `- ${l}`));
  return `${lines.join("\n")}\n`;
}
