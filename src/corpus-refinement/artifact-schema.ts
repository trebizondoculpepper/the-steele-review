import { z } from "zod";
import type {
  CorpusRefinementStage,
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
    }),
  ),
  ...ModelFields,
});

const PAYLOADS = {
  "check-coverage": Coverage,
  "map-claims-to-ideas": Ideas,
  "map-ideas-to-underlying": Underlying,
} satisfies Record<CorpusRefinementStage, z.ZodType>;

export interface StagePayloads {
  "check-coverage": CoverageResult;
  "map-claims-to-ideas": IdeasResult;
  "map-ideas-to-underlying": UnderlyingResult;
}

export class CorpusArtifactError extends Error {
  constructor(
    readonly stage: CorpusRefinementStage,
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
export function readStageArtifact<S extends CorpusRefinementStage>(
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
