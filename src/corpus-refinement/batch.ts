import { z } from "zod";
import type { ArtifactRef, GitArtifactStore } from "../controllers/artifact-store.js";
import { CorpusRefinementInputSchema, type CorpusRefinementInput } from "./contracts.js";

/**
 * Pinned batch input for the Corpus Refinement steps (#856).
 *
 * A run's records are saved once, as one versioned JSON batch, before any
 * step consumes them. Every step then reads that exact saved version,
 * validated on read, and visits its records in order. The batch carries data
 * only; how a step treats it (mode, limits) travels separately as typed
 * parameters. A replayed run finds its own saved batch and reopens it; the
 * same run ID with different records is refused rather than overwritten.
 */

export const BATCH_SCHEMA_VERSION = 1;

const ClaimSchema = CorpusRefinementInputSchema.shape.claims.element;

export const CorpusRefinementBatchSchema = z
  .object({
    schemaVersion: z.literal(BATCH_SCHEMA_VERSION),
    kind: z.literal("corpus-refinement-batch"),
    runId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    /** The records, in the order every step reads them. May be empty. */
    records: z.array(ClaimSchema).max(200),
    /** Records left out of this bounded batch, kept visible. */
    deferred: z.array(z.string().min(1).max(200)).max(5000),
  })
  .strict()
  .refine((b) => new Set(b.records.map((r) => r.id)).size === b.records.length, {
    message: "duplicate record id",
    path: ["records"],
  });
export type CorpusRefinementBatch = z.infer<typeof CorpusRefinementBatchSchema>;

/** Typed parameters: how the steps treat the batch, kept apart from its data. */
export interface BatchParameters {
  runId: string;
  mode: "fixture" | "archive";
}

export const batchPath = (runId: string) => `corpus-refinement/${runId}/batch.json`;

export class BatchError extends Error {
  constructor(
    readonly runId: string,
    readonly reason: string,
  ) {
    super(`corpus-refinement: batch for ${runId} is not usable (${reason})`);
    this.name = "BatchError";
  }
}

/** Split a submission into its saved batch and its typed parameters. */
export function toBatch(input: CorpusRefinementInput): {
  batch: CorpusRefinementBatch;
  parameters: BatchParameters;
} {
  return {
    batch: {
      schemaVersion: BATCH_SCHEMA_VERSION,
      kind: "corpus-refinement-batch",
      runId: input.runId,
      records: input.claims,
      deferred: input.deferred ?? [],
    },
    parameters: { runId: input.runId, mode: input.mode ?? "fixture" },
  };
}

const serialise = (batch: CorpusRefinementBatch) => `${JSON.stringify(batch, null, 2)}\n`;

/**
 * Save the batch before anything consumes it. Saving the same batch again
 * returns the saved version; a different batch under the same run is refused.
 */
export async function saveBatch(
  artifacts: Pick<GitArtifactStore, "lookup" | "read" | "write">,
  batch: CorpusRefinementBatch,
): Promise<ArtifactRef> {
  const valid = CorpusRefinementBatchSchema.parse(batch);
  const path = batchPath(valid.runId);
  const content = serialise(valid);
  const existing = await artifacts.lookup(path);
  if (existing) {
    if ((await artifacts.read(existing)) !== content)
      throw new BatchError(valid.runId, "saved-with-different-records");
    return existing;
  }
  return artifacts.write(path, content);
}

/** Read one exact saved batch, validated against the run it must belong to. */
export async function readBatch(
  artifacts: Pick<GitArtifactStore, "read">,
  ref: ArtifactRef,
  runId: string,
): Promise<CorpusRefinementBatch> {
  let raw: unknown;
  try {
    raw = JSON.parse(await artifacts.read(ref));
  } catch {
    throw new BatchError(runId, "malformed-json");
  }
  const parsed = CorpusRefinementBatchSchema.safeParse(raw);
  if (!parsed.success)
    throw new BatchError(runId, `schema:${parsed.error.issues[0]?.path.join(".") || "root"}`);
  if (parsed.data.runId !== runId) throw new BatchError(runId, `run:${parsed.data.runId}`);
  return parsed.data;
}

/** The batch's records, one at a time, in saved order. */
export function* batchRecords(batch: CorpusRefinementBatch) {
  for (const record of batch.records) yield record;
}

/** The step input rebuilt from the saved batch and the typed parameters. */
export function stepInput(
  batch: CorpusRefinementBatch,
  parameters: BatchParameters,
): CorpusRefinementInput {
  return {
    runId: parameters.runId,
    mode: parameters.mode,
    claims: [...batchRecords(batch)],
    deferred: batch.deferred,
  };
}
