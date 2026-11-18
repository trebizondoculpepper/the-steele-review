import { z } from "zod";
import { ArtifactReferenceSchema } from "../content/artifact-reference.js";

/**
 * Reusable independent research entry.
 *
 * One entry answers one question about a monitored claim using evidence that
 * is separate from the monitored source. Three kinds of material are kept
 * distinguishable by construction, because collapsing them is how a source's
 * assertion becomes a false confirmation:
 *
 * - `monitored` evidence is material from the monitored publication itself. It
 *   shows that the publication made an assertion; it is never independent
 *   confirmation of that assertion.
 * - `external` evidence is independent material that supports or contradicts
 *   the assertion. Only this kind satisfies a supported or contradicted
 *   finding.
 * - `explanation` is generated prose. It is labelled with the model that wrote
 *   it and is not evidence.
 *
 * Rules enforced by {@link parseResearchEntry} (the structural schema alone
 * cannot express them):
 * - A `supported` or `contradicted` finding needs at least one external source.
 * - An `unresolved` finding needs an explicit `unresolvedReason`, so a gap is
 *   recorded rather than silently omitted.
 * - `lastCheckedAt` cannot precede `retrievedAt`, and a source cannot be
 *   published after it was last checked.
 * - Evidence URLs are public HTTPS URLs; the archive reference is optional and
 *   addressed by repository, commit, path and hash.
 */

export const RESEARCH_ENTRY_SCHEMA_VERSION = 1;

export const EvidenceKindSchema = z
  .enum(["external", "monitored"])
  .describe(
    "`external` is independent evidence; `monitored` is material from the monitored publication, which never confirms its own assertion.",
  );
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const FindingSchema = z
  .enum(["supported", "contradicted", "unsupported", "unresolved"])
  .describe(
    "Outcome for one addressed claim. `unsupported` means no evidence was found either way; `unresolved` means the question could not be settled.",
  );
export type Finding = z.infer<typeof FindingSchema>;

export const EvidenceSourceSchema = z
  .object({
    kind: EvidenceKindSchema,
    url: z
      .url({ protocol: /^https$/ })
      .regex(/^https:\/\//)
      .describe("Public HTTPS URL of the evidence source."),
    title: z.string().trim().min(1).max(500).describe("Title of the evidence source."),
    publisher: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Publisher or outlet, when distinct from the title."),
    publishedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Publication time of the source, when it states one. Omitted if unknown."),
    retrievedAt: z.iso
      .datetime({ offset: true })
      .describe("When the source was first retrieved for this research entry."),
    lastCheckedAt: z.iso
      .datetime({ offset: true })
      .describe("When the source was last checked to still contain the quoted passage."),
    passage: z
      .string()
      .min(1)
      .max(4000)
      .describe("Exact quoted passage relied on, preserved as published."),
    artifact: ArtifactReferenceSchema.optional().describe(
      "Immutable archive reference, when the retrieved page was archived.",
    ),
  })
  .strict()
  .meta({
    title: "EvidenceSource",
    description:
      "One evidence source with its exact passage, dates and optional archive reference.",
  });

export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const AddressedClaimSchema = z
  .object({
    claimId: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional()
      .describe("ID of the extracted claim this addresses, when it came from extraction."),
    statement: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe("The claim or question being addressed, restated for a reader."),
    finding: FindingSchema,
    evidence: z
      .array(EvidenceSourceSchema)
      .max(50)
      .describe(
        "Sources consulted for this claim. External sources are required for a settled finding.",
      ),
    unresolvedReason: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe("Why the claim is unresolved. Required when the finding is `unresolved`."),
  })
  .strict()
  .meta({
    title: "AddressedClaim",
    description: "One claim, its finding, and the evidence behind that finding.",
  });

export type AddressedClaim = z.infer<typeof AddressedClaimSchema>;

export const GeneratedExplanationSchema = z
  .object({
    text: z.string().trim().min(1).max(8000).describe("Generated explanation prose."),
    generatedBy: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Provider and model identifier that generated the explanation."),
  })
  .strict()
  .meta({
    title: "GeneratedExplanation",
    description:
      "Model-generated explanation. Labelled as generated and never treated as evidence.",
  });

export type GeneratedExplanation = z.infer<typeof GeneratedExplanationSchema>;

export const ResearchProvenanceSchema = z
  .object({
    modelVersion: z.string().trim().min(1).max(200).describe("Model that produced this entry."),
    promptVersion: z.string().trim().min(1).max(200).describe("Version of the research prompt."),
    createdAt: z.iso
      .datetime({ offset: true })
      .describe("When the entry was created, in ISO 8601 with offset."),
  })
  .strict()
  .meta({ title: "ResearchProvenance", description: "How and when this entry was produced." });

export type ResearchProvenance = z.infer<typeof ResearchProvenanceSchema>;

export const ResearchEntrySchema = z
  .object({
    schemaVersion: z
      .literal(RESEARCH_ENTRY_SCHEMA_VERSION)
      .describe("Version of this research-entry contract."),
    question: z.string().trim().min(1).max(2000).describe("The question this entry answers."),
    addressedClaims: z
      .array(AddressedClaimSchema)
      .min(1)
      .max(50)
      .describe("Claims or questions addressed, each with its own evidence."),
    explanation: GeneratedExplanationSchema,
    limitations: z
      .array(z.string().trim().min(1).max(1000))
      .max(20)
      .describe("What this entry does not establish, stated explicitly. May be empty."),
    unresolvedGaps: z
      .array(z.string().trim().min(1).max(1000))
      .max(20)
      .describe("Known gaps left open, stated explicitly. May be empty."),
    provenance: ResearchProvenanceSchema,
  })
  .strict()
  .meta({
    title: "ResearchEntry",
    description:
      "Independent research entry: addressed claims, labelled generated explanation, evidence, limitations and provenance.",
  });

export type ResearchEntry = z.infer<typeof ResearchEntrySchema>;

export class InvalidResearchEntryError extends Error {
  constructor(reason: string) {
    // Never echo evidence text or model output into logs.
    super(`Invalid research entry: ${reason}`);
    this.name = "InvalidResearchEntryError";
  }
}

/** JSON Schema (draft 2020-12) for {@link ResearchEntrySchema}. */
export function researchEntryJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ResearchEntrySchema) as Record<string, unknown>;
}

function checkEvidence(source: EvidenceSource): void {
  const retrieved = Date.parse(source.retrievedAt);
  const checked = Date.parse(source.lastCheckedAt);
  if (checked < retrieved) {
    throw new InvalidResearchEntryError("lastCheckedAt precedes retrievedAt");
  }
  if (source.publishedAt !== undefined && Date.parse(source.publishedAt) > checked) {
    throw new InvalidResearchEntryError("publishedAt is after lastCheckedAt");
  }
}

function checkClaim(claim: AddressedClaim): void {
  for (const source of claim.evidence) checkEvidence(source);

  if (claim.finding === "supported" || claim.finding === "contradicted") {
    if (!claim.evidence.some((source) => source.kind === "external")) {
      throw new InvalidResearchEntryError(
        `${claim.finding} finding needs at least one external source; monitored material cannot confirm itself`,
      );
    }
  }
  if (claim.finding === "unresolved" && claim.unresolvedReason === undefined) {
    throw new InvalidResearchEntryError("unresolved finding needs an explicit unresolvedReason");
  }
}

/**
 * Validate a research entry, including the rules the structural schema cannot
 * express. Throws {@link InvalidResearchEntryError} on any violation.
 */
export function parseResearchEntry(input: unknown): ResearchEntry {
  const parsed = ResearchEntrySchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidResearchEntryError("structure failed validation");
  }
  for (const claim of parsed.data.addressedClaims) checkClaim(claim);
  return parsed.data;
}
