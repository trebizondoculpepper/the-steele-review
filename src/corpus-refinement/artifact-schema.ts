import { z } from "zod";
import type { RejectedClaimsBatch } from "./rejected-claims.js";
import type {
  CorpusRefinementOutput,
  RejectedOutput,
  CoverageResult,
  IdeasResult,
  UnderlyingResult,
} from "./contracts.js";

/**
 * Validation of saved Corpus Refinement artifacts (#848). A saved artifact is
 * reused, or read by the next stage, only when its envelope names the
 * expected run, stage and schema version, and its payload has the shape that
 * stage produces. Anything else is rejected with a clear reason instead of
 * flowing on as if it were valid.
 */

const Ids = z.array(z.string());
const Issue = z.object({
  index: z.number().int(),
  id: z.string().optional(),
  reason: z.string(),
});
const ModelFields = {
  issues: z.array(Issue).optional(),
  promptVersion: z.string().optional(),
  model: z.string().optional(),
};

const Coverage = z.object({
  covered: Ids,
  uncovered: Ids,
  included: Ids.optional(),
  deferred: Ids.optional(),
});
const Ideas = z.object({
  grouping: z
    .object({
      claims: z.number().int().min(0),
      ideas: z.number().int().min(0),
      sizes: z.record(z.string(), z.number().int().min(0)),
      review: z.literal("near-one-to-one").optional(),
    })
    .optional(),
  ideas: z.array(
    z.object({
      id: z.string().min(1),
      claimIds: Ids,
      statement: z.string().optional(),
      evidence: z.array(z.object({ claimId: z.string(), quote: z.string() })).optional(),
    }),
  ),
  ...ModelFields,
});
const Underlying = z.object({
  underlying: z.array(
    z.object({
      id: z.string().min(1),
      ideaIds: Ids,
      statement: z.string().optional(),
      rationale: z.string().optional(),
      // The proposed relation to the pinned catalogue (#852).
      match: z
        .discriminatedUnion("decision", [
          z.object({ decision: z.literal("reuse"), catalogueId: z.string() }),
          z.object({ decision: z.literal("new") }),
          z.object({ decision: z.literal("uncertain"), candidates: Ids }),
        ])
        .optional(),
    }),
  ),
  /** The exact catalogue version the proposals were made against (#852). */
  catalogue: z
    .object({ repository: z.string(), commit: z.string(), path: z.string(), sha256: z.string() })
    .optional(),
  ...ModelFields,
});

const Rejected = z.object({
  from: z.enum(["map-claims-to-ideas", "map-ideas-to-underlying"]),
  sent: z.number().int().min(0),
  unplaced: Ids,
  issues: z.array(Issue),
});

const Ref = z
  .object({
    repository: z.string().min(1),
    commit: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().min(1),
  })
  .strict();
const RejectedClaims = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("corpus-rejected-claims"),
  runId: z.string(),
  // Provenance is required: a batch without its exact sources is not usable (#855).
  sources: z.object({ batch: Ref, ideas: Ref, rejected: z.array(Ref) }).strict(),
  entries: z.array(
    z.looseObject({
      claimId: z.string(),
      statement: z.string(),
      stage: z.enum(["map-claims-to-ideas", "map-ideas-to-underlying"]),
      reason: z.enum(["unmapped", "idea-not-grouped"]),
    }),
  ),
  candidates: z.array(
    z.looseObject({
      stage: z.string(),
      index: z.number().int().min(0),
      reason: z.string(),
      output: Ref,
    }),
  ),
  technical: z.array(z.looseObject({ stage: z.string(), reason: z.string(), output: Ref })),
});

const PAYLOADS = {
  "check-coverage": Coverage,
  "map-claims-to-ideas": Ideas,
  "map-ideas-to-underlying": Underlying,
  "map-claims-to-ideas-rejected": Rejected,
  "map-ideas-to-underlying-rejected": Rejected,
  "rejected-claims": RejectedClaims,
} satisfies Record<CorpusRefinementOutput, z.ZodType>;

export interface StagePayloads {
  "check-coverage": CoverageResult;
  "map-claims-to-ideas": IdeasResult;
  "map-ideas-to-underlying": UnderlyingResult;
  "map-claims-to-ideas-rejected": RejectedOutput;
  "map-ideas-to-underlying-rejected": RejectedOutput;
  "rejected-claims": RejectedClaimsBatch;
}

export class CorpusArtifactError extends Error {
  constructor(
    readonly stage: CorpusRefinementOutput,
    readonly runId: string,
    readonly reason: string,
  ) {
    super(`corpus-refinement: saved ${stage} for ${runId} is not usable (${reason})`);
    this.name = "CorpusArtifactError";
  }
}

/**
 * Parse one saved artifact and check it against what the caller expects.
 * `identity`, when given, must match too (reuse checks it; a pinned
 * downstream read already holds the exact version and checks the rest).
 */
export function readStageArtifact<S extends CorpusRefinementOutput>(
  text: string,
  expected: { runId: string; stage: S; identity?: string },
): { identity: string; value: StagePayloads[S] } {
  const fail = (reason: string): never => {
    throw new CorpusArtifactError(expected.stage, expected.runId, reason);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("malformed-json");
  }
  const envelope = z
    .object({
      schemaVersion: z.unknown(),
      stage: z.unknown(),
      runId: z.unknown(),
      identity: z.unknown(),
      value: z.unknown(),
    })
    .safeParse(raw);
  if (!envelope.success) return fail("not-an-artifact");
  const e = envelope.data;
  if (e.schemaVersion !== 1) return fail("schema-version-mismatch");
  if (e.stage !== expected.stage) return fail("stage-mismatch");
  if (e.runId !== expected.runId) return fail("run-mismatch");
  if (typeof e.identity !== "string" || !e.identity) return fail("identity-missing");
  if (expected.identity !== undefined && e.identity !== expected.identity)
    return fail("identity-mismatch");
  const value = PAYLOADS[expected.stage].safeParse(e.value);
  if (!value.success) return fail(`payload:${value.error.issues[0]?.path.join(".") || "root"}`);
  return { identity: e.identity, value: value.data as StagePayloads[S] };
}
