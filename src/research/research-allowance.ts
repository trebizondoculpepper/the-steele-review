import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import { researchJobPath } from "./job.js";

/**
 * Research selection under a per-article allowance of NEW jobs (#596, #533).
 *
 * Policy `new-jobs-allowance-v1`, applied to the librarian's ranked
 * candidates in rank order (the ranking itself, most claims still needing
 * evidence first with the job ID breaking ties, is `rankResearchRequests`):
 *
 * 1. A candidate seen earlier in the list is a `duplicate` and is skipped.
 * 2. A candidate whose job already has a saved result is `reuse`: it costs
 *    no new job, whichever article or round commissioned it.
 * 3. A candidate this article already commissioned in an earlier round, with
 *    no result yet, is `in-flight`: it was counted when it was commissioned
 *    and is not counted again.
 * 4. Otherwise it is `new` while the allowance has room, else `deferred`.
 *
 * The allowance is shared by every research round of one article: jobs
 * counted by earlier selections for the same post reduce what is left. Each
 * selection is saved in the article's ledger, keyed by the analysis and its
 * candidates, so a replay reads its own earlier decision and never spends the
 * allowance twice. Monetary spend is controlled outside (OpenRouter key limits); this
 * counts jobs only and makes no cost claim.
 */
export const RESEARCH_SELECTION_POLICY = "new-jobs-allowance-v1";

export type SelectionDecision =
  "reuse" | "in-flight" | "new" | "deferred" | "duplicate";

export interface SelectionCandidate {
  jobId: string;
  rank: number;
}

export interface SelectedCandidate {
  jobId: string;
  rank: number;
  decision: SelectionDecision;
  reason: string;
}

/** Pure selection: no store, no provider. */
export function selectResearch(
  candidates: SelectionCandidate[],
  input: {
    /** Configured NEW jobs per article, across all its rounds. */
    allowance: number;
    /** Jobs whose result is already saved. */
    reusable: ReadonlySet<string>;
    /** Jobs this article counted in earlier selections. */
    counted: ReadonlySet<string>;
  },
): {
  decisions: SelectedCandidate[];
  remainingBefore: number;
  newJobs: number;
} {
  const remainingBefore = Math.max(0, input.allowance - input.counted.size);
  let remaining = remainingBefore;
  const seen = new Set<string>();
  const decisions = [...candidates]
    .sort((a, b) => a.rank - b.rank || a.jobId.localeCompare(b.jobId))
    .map(({ jobId, rank }): SelectedCandidate => {
      if (seen.has(jobId))
        return {
          jobId,
          rank,
          decision: "duplicate",
          reason: "same job as a higher-ranked candidate",
        };
      seen.add(jobId);
      if (input.reusable.has(jobId))
        return {
          jobId,
          rank,
          decision: "reuse",
          reason: "saved result reused; no new job",
        };
      if (input.counted.has(jobId))
        return {
          jobId,
          rank,
          decision: "in-flight",
          reason: "already commissioned for this article; counted once",
        };
      if (remaining > 0) {
        remaining--;
        return {
          jobId,
          rank,
          decision: "new",
          reason: `new job within the article allowance (${input.allowance})`,
        };
      }
      return {
        jobId,
        rank,
        decision: "deferred",
        reason: `article allowance of ${input.allowance} new job(s) is used`,
      };
    });
  return {
    decisions,
    remainingBefore,
    newJobs: decisions.filter((d) => d.decision === "new").length,
  };
}

/** Decisions that dispatch a research call (a reused one returns its saved result). */
export const dispatched = (d: SelectionDecision) =>
  d === "new" || d === "reuse" || d === "in-flight";

const Ref = z
  .object({
    repository: z.string(),
    commit: z.string(),
    path: z.string(),
    sha256: z.string(),
  })
  .strict();
export const AllowanceRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    policy: z.literal(RESEARCH_SELECTION_POLICY),
    allowance: z.number().int().nonnegative(),
    themeResult: Ref,
    claimResult: Ref,
    /** Allowance left before this selection. */
    remainingBefore: z.number().int().nonnegative(),
    decisions: z
      .array(
        z
          .object({
            jobId: z.string(),
            rank: z.number().int().positive(),
            decision: z.enum([
              "reuse",
              "in-flight",
              "new",
              "deferred",
              "duplicate",
            ]),
            reason: z.string().max(300),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type AllowanceRecord = z.infer<typeof AllowanceRecordSchema>;

const plain = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.sha256,
});
/**
 * One revisable ledger per article holds every selection for it. Each
 * selection is a compare-and-set revision of the ledger, so two runs for the
 * same post (for example, different source versions at once) can never both
 * spend the same remaining allowance: the loser re-reads and re-selects.
 */
export const ALLOWANCE_LEDGER_PREFIX = "librarian/research-allowance/";
const ledgerPath = (post: { publicationId: string; postId: string }) =>
  `${ALLOWANCE_LEDGER_PREFIX}${post.publicationId}/${post.postId}/ledger.json`;
/** Bound on selections held per article. */
export const MAX_ALLOWANCE_SELECTIONS = 200;
const LedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    selections: z.record(
      z.string().regex(/^[0-9a-f]{32}$/),
      AllowanceRecordSchema,
    ),
  })
  .strict();
const STALE_RETRIES = 5;

/**
 * Select and save, or return the selection already saved for exactly this
 * analysis and candidate set (a replay or retry).
 */
export async function selectAndSaveResearch(
  artifacts: Pick<GitArtifactStore, "lookup" | "read" | "revise">,
  input: {
    post: { publicationId: string; postId: string };
    themeResult: ArtifactRef;
    claimResult: ArtifactRef;
    candidates: SelectionCandidate[];
    allowance: number;
  },
): Promise<{ record: AllowanceRecord; ref: ArtifactRef }> {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        RESEARCH_SELECTION_POLICY,
        input.allowance,
        plain(input.themeResult),
        plain(input.claimResult),
        input.candidates.map((c) => [c.rank, c.jobId]),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const path = ledgerPath(input.post);
  const reusable = new Set<string>();
  for (const c of input.candidates) {
    if (await artifacts.lookup(researchJobPath(c.jobId, "result")))
      reusable.add(c.jobId);
  }
  for (let attempt = 0; ; attempt++) {
    const current = await artifacts.lookup(path);
    // An unreadable ledger may hold counted jobs: fail rather than overspend.
    const ledger = current
      ? LedgerSchema.parse(JSON.parse(await artifacts.read(current)))
      : { schemaVersion: 1 as const, selections: {} };
    const saved = ledger.selections[key];
    if (saved && current) return { record: saved, ref: current };
    if (Object.keys(ledger.selections).length >= MAX_ALLOWANCE_SELECTIONS)
      throw new Error("research allowance history too long");
    const counted = new Set<string>();
    for (const r of Object.values(ledger.selections))
      for (const d of r.decisions)
        if (d.decision === "new") counted.add(d.jobId);
    const selected = selectResearch(input.candidates, {
      allowance: input.allowance,
      reusable,
      counted,
    });
    const record = AllowanceRecordSchema.parse({
      schemaVersion: 1,
      policy: RESEARCH_SELECTION_POLICY,
      allowance: input.allowance,
      themeResult: plain(input.themeResult),
      claimResult: plain(input.claimResult),
      remainingBefore: selected.remainingBefore,
      decisions: selected.decisions,
    });
    const next = {
      ...ledger,
      selections: { ...ledger.selections, [key]: record },
    };
    try {
      const ref = await artifacts.revise(
        path,
        `${JSON.stringify(next, null, 2)}\n`,
        current ? current.sha256 : null,
      );
      return { record, ref };
    } catch (error) {
      // Another selection for this article committed first: re-read, re-select.
      const stale =
        error instanceof ArtifactStoreError &&
        (error.code === "stale-revision" ||
          error.code === "immutable-conflict");
      if (!stale || attempt >= STALE_RETRIES) throw error;
    }
  }
}
