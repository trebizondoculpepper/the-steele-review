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
    /**
     * `fixture` (default): deterministic stubs, no model calls. `archive`
     * (#832): a bounded batch of archived claims, with coverage from saved
     * records and both mappings model-backed.
     */
    mode: z.enum(["fixture", "archive"]).optional(),
    claims: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            statement: z.string().min(1).max(2000),
            /** Archive mode: the claim's saved utterance, quoted from the source. */
            utterance: z.string().max(4000).optional(),
            /** Archive mode: covered by saved evidence in the librarian's coverage record. */
            covered: z.boolean().optional(),
            /** Archive mode: the post the claim came from (publicationId/postId). */
            post: z.string().max(400).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    /** Archive mode: claims left out of this bounded batch, recorded, never dropped silently. */
    deferred: z.array(z.string().min(1).max(200)).max(5000).optional(),
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
  /** Archive mode: the claims in the batch, and those deferred from it (#832). */
  included?: string[];
  deferred?: string[];
}
export interface IdeasResult {
  ideas: {
    id: string;
    claimIds: string[];
    statement?: string;
    evidence?: { claimId: string; quote: string }[];
  }[];
  /** Candidates the stage rejected (#836, #837); kept visible, never passed on. */
  issues?: ItemIssue[];
  /** Prompt and model that produced a model-backed result. */
  promptVersion?: string;
  model?: string;
}
export interface UnderlyingResult {
  underlying: { id: string; ideaIds: string[]; statement?: string; rationale?: string }[];
  issues?: ItemIssue[];
  promptVersion?: string;
  model?: string;
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

/** One rejected candidate record, or a whole-response problem (index -1) (#836). */
export interface ItemIssue {
  index: number;
  /** The candidate's own ID, when it had a readable one. */
  id?: string;
  reason: string;
}

/**
 * Typed validation outcome of one model response (#836): the records that
 * passed and the issues found. Both may be non-empty; what to save, defer or
 * repair is the workflow's decision.
 */
export interface ExtractionOutcome<T> {
  accepted: T[];
  issues: ItemIssue[];
}
