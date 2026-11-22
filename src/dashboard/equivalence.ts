import { z } from "zod";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import {
  ClaimEquivalenceDecisionSchema,
  canonicalOf,
} from "../analysis/claim-equivalence.js";

/**
 * Read-only browser for saved claim-equivalence decisions (#616).
 *
 * Each decision records why an assertion was either matched to an existing
 * claim or kept separate. This view exposes exactly what was saved: the
 * statement, candidates, outcome, confidence, reason, model/prompt identity
 * and date. Equivalence is not evidence of truth, and similar wording is not
 * merged by this page.
 */

export const EQUIVALENCE_PAGE = 20;
export const EQUIVALENCE_SCAN = 200;
const LIST_PAGE = 50;
const DECISION = /^claim-equivalence\/(claim-[0-9a-f]{32})-[0-9a-f]{16}\.json$/;

export type EquivalenceOutcome = "equivalent" | "separate";

export interface EquivalenceRow {
  path: string;
  recordId: string;
  statement: string;
  outcome: EquivalenceOutcome;
  match: string | null;
  confidence: "high" | "medium" | "low" | null;
  reason: string;
  candidates: { id: string; statement: string }[];
  modelVersion: string;
  promptVersion: string;
  decidedAt: string;
}

export interface EquivalenceListing {
  state: "ok" | "unavailable";
  rows: EquivalenceRow[];
  next?: string;
  partial: boolean;
  unreadable: number;
}

export interface EquivalenceDetail {
  row: EquivalenceRow;
  /** Current canonical claim after any recorded merges, when resolvable. */
  canonical?: string;
  occurrences: {
    publicationId: string;
    postId: string;
    passage: string;
    occurrenceId?: string;
  }[];
  occurrencesPartial: boolean;
}

export interface EquivalencePort {
  list(filter: { query?: string; outcome?: EquivalenceOutcome; after?: string }): Promise<EquivalenceListing>;
  detail(path: string): Promise<EquivalenceDetail | undefined>;
}

const ClaimRecordSchema = z
  .object({
    id: z.string(),
    statement: z.string(),
    occurrences: z
      .array(
        z
          .object({
            publicationId: z.string(),
            postId: z.string(),
            passage: z.string(),
            occurrenceId: z.string().optional(),
          })
          .loose(),
      )
      .max(10_000)
      .optional(),
  })
  .loose();

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;

const rowOf = (path: string, decision: z.infer<typeof ClaimEquivalenceDecisionSchema>): EquivalenceRow => ({
  path,
  recordId: decision.record,
  statement: decision.statement,
  outcome: decision.match === null ? "separate" : "equivalent",
  match: decision.match,
  confidence: decision.confidence,
  reason: decision.reason,
  candidates: decision.candidates,
  modelVersion: decision.modelVersion,
  promptVersion: decision.promptVersion,
  decidedAt: decision.decidedAt,
});

export function savedEquivalence(content: Store): EquivalencePort {
  const readRow = async (path: string): Promise<EquivalenceRow | undefined> => {
    try {
      const ref = await content.lookup(path);
      if (!ref) return undefined;
      const parsed = ClaimEquivalenceDecisionSchema.safeParse(JSON.parse(await content.read(ref)));
      return parsed.success ? rowOf(path, parsed.data) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async list({ query, outcome, after }) {
      const q = query?.trim().toLowerCase();
      const rows: EquivalenceRow[] = [];
      let unreadable = 0;
      let scanned = 0;
      let cursor = after;
      let partial = false;
      let exhausted = false;
      while (rows.length < EQUIVALENCE_PAGE && scanned < EQUIVALENCE_SCAN) {
        let paths: string[];
        try {
          paths = await content.list("claim-equivalence", LIST_PAGE, cursor);
        } catch {
          return { state: "unavailable", rows: [], partial: false, unreadable: 0 };
        }
        if (paths.length === 0) {
          exhausted = true;
          break;
        }
        for (const path of paths) {
          cursor = path;
          if (!path.endsWith(".json")) continue;
          if (!DECISION.test(path)) {
            // A saved file with an unexpected name is not silently absent.
            unreadable++;
            continue;
          }
          scanned++;
          const row = await readRow(path);
          if (!row) {
            unreadable++;
            continue;
          }
          if (outcome && row.outcome !== outcome) {
            if (rows.length >= EQUIVALENCE_PAGE || scanned >= EQUIVALENCE_SCAN) break;
            continue;
          }
          if (
            q &&
            !row.statement.toLowerCase().includes(q) &&
            !row.reason.toLowerCase().includes(q) &&
            !row.candidates.some((c) => c.statement.toLowerCase().includes(q))
          ) {
            if (rows.length >= EQUIVALENCE_PAGE || scanned >= EQUIVALENCE_SCAN) break;
            continue;
          }
          rows.push(row);
          if (rows.length >= EQUIVALENCE_PAGE || scanned >= EQUIVALENCE_SCAN) break;
        }
      }
      if (scanned >= EQUIVALENCE_SCAN) partial = true;
      return {
        state: "ok",
        rows,
        ...(exhausted || cursor === undefined ? {} : { next: cursor }),
        partial,
        unreadable,
      };
    },

    async detail(path) {
      if (!DECISION.test(path)) return undefined;
      const row = await readRow(path);
      if (!row) return undefined;
      let canonical: string | undefined;
      try {
        canonical = await canonicalOf(content as GitArtifactStore, row.recordId);
      } catch {
        canonical = undefined;
      }
      const occurrences: EquivalenceDetail["occurrences"] = [];
      let occurrencesPartial = false;
      try {
        const ref = await content.lookup(`claims/${row.recordId}.json`);
        if (ref) {
          const record = ClaimRecordSchema.safeParse(JSON.parse(await content.read(ref)));
          if (!record.success) occurrencesPartial = true;
          else {
            const list = record.data.occurrences ?? [];
            if (list.length > 100) occurrencesPartial = true;
            for (const o of list.slice(0, 100)) {
              occurrences.push({
                publicationId: o.publicationId,
                postId: o.postId,
                passage: o.passage,
                ...(o.occurrenceId ? { occurrenceId: o.occurrenceId } : {}),
              });
            }
          }
        }
      } catch {
        occurrencesPartial = true;
      }
      return {
        row,
        ...(canonical ? { canonical } : {}),
        occurrences,
        occurrencesPartial,
      };
    },
  };
}
