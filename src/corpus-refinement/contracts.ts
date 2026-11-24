import { z } from "zod";

/**
 * Corpus Refinement contracts (#830): the schemas and types for saved
 * artifacts and for data exchanged between stages. Owner-approved layout:
 * doc/architecture/19-themes-and-dossiers.md, "Experimental TypeScript layout".
 */

export const CORPUS_REFINEMENT_STAGES = [
  "check-coverage",
  "map-claims-to-ideas",
  "map-ideas-to-underlying",
] as const;
export type CorpusRefinementStage = (typeof CORPUS_REFINEMENT_STAGES)[number];

const RunId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);

export const CorpusRefinementInputSchema = z
  .object({
    runId: RunId,
    claims: z
      .array(
        z
          .object({ id: z.string().min(1).max(200), statement: z.string().min(1).max(2000) })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type CorpusRefinementInput = z.infer<typeof CorpusRefinementInputSchema>;

/** A saved stage artifact, by exact version. */
export interface StageRef {
  repository: string;
  commit: string;
  path: string;
  sha256: string;
}

export interface CoverageResult {
  covered: string[];
  uncovered: string[];
}
export interface IdeasResult {
  ideas: { id: string; claimIds: string[] }[];
}
export interface UnderlyingResult {
  underlying: { id: string; ideaIds: string[] }[];
}

/** The saved envelope of one stage artifact: what produced it, and its value. */
export interface StageArtifact<T> {
  schemaVersion: 1;
  stage: CorpusRefinementStage;
  runId: string;
  /** Hash of stage, logic version and exact inputs; reuse requires a match. */
  identity: string;
  value: T;
}

/** Where one stage's artifact lives, derived only from the run ID and stage name. */
export const corpusRefinementPath = (runId: string, stage: CorpusRefinementStage) =>
  `corpus-refinement/${runId}/${stage}.json`;

export interface CorpusRefinementResult {
  runId: string;
  stages: { stage: CorpusRefinementStage; artifact: StageRef }[];
}

/** A bounded synthetic batch for the prototype CLI and tests. */
export function syntheticBatch(runId: string, size: number): CorpusRefinementInput {
  const words = ["masts", "towers", "vaccines", "satellites", "meters"];
  return {
    runId,
    claims: Array.from({ length: Math.max(1, Math.min(200, size)) }, (_, i) => ({
      id: `claim-${String(i).padStart(3, "0")}`,
      statement: `${words[i % words.length]} synthetic claim ${i}`,
    })),
  };
}
