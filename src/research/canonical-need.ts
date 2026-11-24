import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ClaimSchema,
  ClaimTypeSchema,
  DateMentionSchema,
  claimIdFor,
} from "../analysis/claim.js";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import {
  ClaimOccurrenceSchema,
  occurrenceIdFor,
} from "../analysis/claim-occurrence.js";
import {
  AssertionKindSchema,
  candidateReasons,
} from "../analysis/claim-candidates.js";

/** Preserve signs, decimals, units, case and negation; only canonical Unicode/spacing changes. */
export const normalisePropositionText = (text: string): string =>
  text.normalize("NFC").replace(/\s+/gu, " ").trim();
const Text = z.string().min(1).max(2000);
const SemanticClaimSchema = z.looseObject({
  statement: Text,
  claimType: ClaimTypeSchema.optional(),
  qualifiers: z.array(z.string().min(1).max(200)).max(20).optional(),
  entities: z.array(z.string().min(1).max(200)).max(50).optional(),
  dates: z.array(DateMentionSchema).max(20).optional(),
});
const SpeakerSchema = z.looseObject({
  kind: z.enum(["author-voice", "quoted", "unknown", "uncertain"]),
  name: z.string().min(1).max(200).optional(),
  attribution: Text.optional(),
});
export const CanonicalNeedSchema = z
  .object({
    version: z.literal("canonical-theme-need-v1"),
    themeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    proposition: z
      .object({
        statement: Text,
        kind: AssertionKindSchema,
        claimType: ClaimTypeSchema.optional(),
        qualifiers: z.array(z.string().min(1).max(200)).max(20).optional(),
        entities: z.array(z.string().min(1).max(200)).max(50).optional(),
        dates: z.array(DateMentionSchema).max(20).optional(),
        /** A quoted claim's actual attributed speaker, never the post author/byline. */
        attribution: z
          .object({
            name: z.string().min(1).max(200),
            wording: Text.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    /** Context-dependent/unknown-speaker material is never shared by display text alone. */
    occurrenceScope: z.string().min(1).max(200).optional(),
  })
  .strict();
export const CanonicalNeedSetSchema = z
  .object({
    version: z.literal("canonical-theme-needs-v1"),
    needs: z.array(CanonicalNeedSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.needs.map(canonicalNeedId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "canonical needs must be unique",
      });
    if (new Set(value.needs.map((n) => n.themeId)).size !== 1)
      ctx.addIssue({
        code: "custom",
        message: "canonical needs must name one theme",
      });
  });
export const NeedOccurrenceBindingSchema = z
  .object({
    schemaVersion: z.number().int().min(1).max(4),
    publicationId: z.string().min(1).max(200),
    postId: z.string().min(1).max(200),
    sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    source: ArtifactReferenceSchema,
    analysis: ArtifactReferenceSchema,
    index: z.number().int().min(0).max(100000),
  })
  .strict();
export type CanonicalNeed = z.infer<typeof CanonicalNeedSchema>;
const semanticValues = (values: string[]) =>
  values.map(normalisePropositionText);

/** Semantic identity comes only from accepted proposition data and a resolved canonical topic. */
export function canonicalNeed(input: {
  themeId: string;
  claimRecordId: string;
  kind: z.infer<typeof AssertionKindSchema>;
  claim: unknown;
  occurrence: unknown;
  /** Exact accepted extraction association, supplied by the validated analysis reader. */
  binding: z.infer<typeof NeedOccurrenceBindingSchema>;
}): CanonicalNeed {
  const binding = NeedOccurrenceBindingSchema.parse(input.binding);
  const claim = SemanticClaimSchema.parse(input.claim);
  const occurrence = z
    .looseObject({ speaker: SpeakerSchema.optional() })
    .parse(input.occurrence);
  const speaker = occurrence.speaker;
  const statement = normalisePropositionText(claim.statement);
  const attributed = speaker?.kind === "quoted" && speaker.name;
  // A date has a value only when its wording is unambiguous. Without one, its
  // meaning may depend on when the source was published ("two days ago",
  // "Monday", "March 3"), so it stays occurrence-specific. Only an explicit
  // year with no relative wording ("in 2019") is source-independent.
  const unresolvedDate = claim.dates?.some(
    (d) =>
      !d.value &&
      !(
        /\b(1[5-9]|20)\d{2}\b/.test(d.text) &&
        !/\b(today|yesterday|tomorrow|ago|last|next|this|coming|previous|recent(ly)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(
          d.text,
        )
      ),
  );
  const fullClaim = ClaimSchema.safeParse(input.claim);
  const fullOccurrence = ClaimOccurrenceSchema.safeParse(input.occurrence);
  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const accepted =
    binding.schemaVersion >= 3 &&
    fullClaim.success &&
    fullOccurrence.success &&
    fullOccurrence.data.publicationId === binding.publicationId &&
    fullOccurrence.data.postId === binding.postId &&
    fullOccurrence.data.publisher.publicationId === binding.publicationId &&
    fullClaim.data.sourceVersion === binding.sourceVersion &&
    fullOccurrence.data.sourceVersion === binding.sourceVersion &&
    fullOccurrence.data.claimId === fullClaim.data.id &&
    fullClaim.data.id ===
      claimIdFor({
        sourceVersion: fullClaim.data.sourceVersion,
        ...fullClaim.data.span,
        statement: fullClaim.data.statement,
        modelVersion: fullClaim.data.extraction.modelVersion,
        promptVersion: fullClaim.data.extraction.promptVersion,
      }) &&
    fullOccurrence.data.occurrenceId ===
      occurrenceIdFor({
        publicationId: binding.publicationId,
        postId: binding.postId,
        sourceVersion: binding.sourceVersion,
        ...fullClaim.data.span,
      }) &&
    fullOccurrence.data.statement === fullClaim.data.statement &&
    fullOccurrence.data.assertionKind === input.kind &&
    fullOccurrence.data.claimType === fullClaim.data.claimType &&
    equal(fullOccurrence.data.artifact, fullClaim.data.artifact) &&
    equal(fullClaim.data.artifact, binding.source) &&
    equal(fullOccurrence.data.span, fullClaim.data.span) &&
    fullOccurrence.data.passage === fullClaim.data.passage &&
    equal(fullOccurrence.data.qualifiers, fullClaim.data.qualifiers) &&
    equal(fullOccurrence.data.assertionDates, fullClaim.data.dates) &&
    equal(fullOccurrence.data.extraction, fullClaim.data.extraction);
  const contextual =
    !accepted ||
    speaker?.kind === "unknown" ||
    speaker?.kind === "uncertain" ||
    candidateReasons(input.kind, [input.themeId], statement).length > 0 ||
    (input.kind === "quotation" && !attributed) ||
    unresolvedDate;
  return CanonicalNeedSchema.parse({
    version: "canonical-theme-need-v1",
    themeId: input.themeId,
    proposition: {
      statement,
      kind: input.kind,
      ...(claim.claimType ? { claimType: claim.claimType } : {}),
      ...(claim.qualifiers
        ? { qualifiers: semanticValues(claim.qualifiers) }
        : {}),
      ...(claim.entities ? { entities: semanticValues(claim.entities) } : {}),
      ...(claim.dates
        ? {
            dates: claim.dates.map((d) => ({
              ...d,
              text: normalisePropositionText(d.text),
            })),
          }
        : {}),
      ...(attributed
        ? {
            attribution: {
              name: normalisePropositionText(speaker.name!),
              ...(speaker.attribution
                ? { wording: normalisePropositionText(speaker.attribution) }
                : {}),
            },
          }
        : {}),
    },
    ...(contextual
      ? {
          occurrenceScope: createHash("sha256")
            .update(
              JSON.stringify({
                analysis: binding.analysis,
                post: [binding.publicationId, binding.postId],
                sourceVersion: binding.sourceVersion,
                index: binding.index,
                occurrenceId: fullOccurrence.success
                  ? fullOccurrence.data.occurrenceId
                  : undefined,
              }),
            )
            .digest("hex"),
        }
      : {}),
  });
}
export const canonicalNeedId = (need: CanonicalNeed): string =>
  `need-${createHash("sha256")
    .update(JSON.stringify(CanonicalNeedSchema.parse(need)))
    .digest("hex")
    .slice(0, 40)}`;
