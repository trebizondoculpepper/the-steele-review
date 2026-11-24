import type {
  CorpusRefinementInput,
  IdeasResult,
  ItemIssue,
  RejectedOutput,
  StageRef,
} from "./contracts.js";

/**
 * Reject handler for the two-stage experiment (#855). It only collects and
 * saves: from the mappers' saved rejected outputs (#857), it builds one
 * versioned rejected-claims batch per run, attributing each rejection to the
 * original claim utterance wherever that is certain.
 *
 * - A claim the first mapper left unplaced is attributed directly.
 * - An idea the second mapper did not group is traced back to its claims;
 *   a claim that another grouped idea also carries keeps that link.
 * - A candidate that failed validation is kept by reference (stage, index,
 *   ID, reason), never attributed to claims: which claim a malformed
 *   candidate meant cannot be known.
 * - Whole-response problems (malformed JSON, a missing list, truncation) are
 *   technical failures, kept apart from claim rejections.
 */

export const REJECTED_CLAIMS_SCHEMA_VERSION = 1;

export interface RejectedClaimEntry {
  claimId: string;
  /** The claim's saved utterance, quoted from its source, when the batch has one. */
  utterance?: string;
  statement: string;
  /** The source post (publicationId/postId), when the batch records one. */
  post?: string;
  stage: "map-claims-to-ideas" | "map-ideas-to-underlying";
  reason: "unmapped" | "idea-not-grouped";
  /** For idea-not-grouped: the idea that was left out. */
  ideaId?: string;
  /** Other accepted ideas that carry this claim and were grouped. */
  acceptedElsewhere?: string[];
}

export interface RejectedCandidate {
  stage: RejectedOutput["from"];
  index: number;
  id?: string;
  reason: string;
  /** The saved rejected output that records it. */
  output: StageRef;
}

export interface RejectedClaimsBatch {
  schemaVersion: typeof REJECTED_CLAIMS_SCHEMA_VERSION;
  kind: "corpus-rejected-claims";
  runId: string;
  /** The exact saved inputs this batch was built from. */
  sources: { batch: StageRef; ideas: StageRef; rejected: StageRef[] };
  entries: RejectedClaimEntry[];
  candidates: RejectedCandidate[];
  technical: { stage: RejectedOutput["from"]; reason: string; output: StageRef }[];
}

/** Build the run's rejected-claims batch. Pure: every input is a saved value. */
export function collectRejectedClaims(input: {
  runId: string;
  claims: CorpusRefinementInput["claims"];
  ideas: IdeasResult;
  grouped: string[];
  rejected: { output: StageRef; value: RejectedOutput }[];
  sources: RejectedClaimsBatch["sources"];
}): RejectedClaimsBatch {
  const claimById = new Map(input.claims.map((c) => [c.id, c]));
  const grouped = new Set(input.grouped);
  const entries: RejectedClaimEntry[] = [];
  const seen = new Set<string>();
  const entry = (e: Omit<RejectedClaimEntry, "statement" | "utterance" | "post">) => {
    const claim = claimById.get(e.claimId);
    const key = `${e.stage}|${e.reason}|${e.claimId}|${e.ideaId ?? ""}`;
    if (!claim || seen.has(key)) return; // never guess a claim the batch does not hold
    seen.add(key);
    entries.push({
      ...e,
      statement: claim.statement,
      ...(claim.utterance ? { utterance: claim.utterance } : {}),
      ...(claim.post ? { post: claim.post } : {}),
    });
  };
  const candidates: RejectedCandidate[] = [];
  const technical: RejectedClaimsBatch["technical"] = [];
  const keep = (output: StageRef, from: RejectedOutput["from"], issues: ItemIssue[]) => {
    for (const issue of issues) {
      if (issue.index < 0) technical.push({ stage: from, reason: issue.reason, output });
      else
        candidates.push({
          stage: from,
          index: issue.index,
          ...(issue.id ? { id: issue.id } : {}),
          reason: issue.reason,
          output,
        });
    }
  };
  for (const { output, value } of input.rejected) {
    keep(output, value.from, value.issues);
    if (value.from === "map-claims-to-ideas") {
      for (const claimId of value.unplaced)
        entry({ claimId, stage: "map-claims-to-ideas", reason: "unmapped" });
    } else {
      for (const ideaId of value.unplaced) {
        const idea = input.ideas.ideas.find((i) => i.id === ideaId);
        for (const claimId of idea?.claimIds ?? []) {
          const elsewhere = input.ideas.ideas
            .filter((i) => i.id !== ideaId && grouped.has(i.id) && i.claimIds.includes(claimId))
            .map((i) => i.id);
          entry({
            claimId,
            stage: "map-ideas-to-underlying",
            reason: "idea-not-grouped",
            ideaId,
            ...(elsewhere.length ? { acceptedElsewhere: elsewhere } : {}),
          });
        }
      }
    }
  }
  return {
    schemaVersion: REJECTED_CLAIMS_SCHEMA_VERSION,
    kind: "corpus-rejected-claims",
    runId: input.runId,
    sources: input.sources,
    entries,
    candidates,
    technical,
  };
}
