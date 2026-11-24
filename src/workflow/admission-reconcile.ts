import type { OperationStore } from "../controllers/operation-store.js";

/**
 * Reconcile automatic admissions before switching to admission by post
 * (#874). Every post that already had an automatic article run is recorded
 * as admitted under the revision it ran, so the switch can never start a
 * second run for it and never replays the backlog.
 *
 * Two durable sources are read: Restate's own ArticleRun workflow keys, and
 * the content repository's captured-submission records, which outlive
 * Restate's retention. Nothing is submitted, and an existing admission is
 * never replaced.
 */

export interface AdmissionCandidate {
  publicationId: string;
  postId: string;
  /** `pub/post@<32 hex>`, the base ArticleRun key. */
  workflowKey: string;
  source: "restate" | "submission";
}

/** An ArticleRun key, optionally with an attempt or recovery suffix. */
const RUN_KEY =
  /^([a-z0-9][a-z0-9-]{0,199})\/([a-z0-9][a-z0-9-]{0,199})@([0-9a-f]{32})(?:~[a-z0-9-]{1,80})*$/;
/** A captured submission: `article-submissions/<pub>/<post>/<64 hex>/<hash>.json`. */
const SUBMISSION =
  /^article-submissions\/([a-z0-9][a-z0-9-]{0,199})\/([a-z0-9][a-z0-9-]{0,199})\/([0-9a-f]{64})\/[0-9a-f]{64}\.json$/;

export function candidatesFromWorkflowKeys(keys: string[]): AdmissionCandidate[] {
  return keys.flatMap((key) => {
    const m = RUN_KEY.exec(key);
    return m
      ? [
          {
            publicationId: m[1]!,
            postId: m[2]!,
            workflowKey: `${m[1]}/${m[2]}@${m[3]}`,
            source: "restate" as const,
          },
        ]
      : [];
  });
}

export function candidatesFromSubmissionPaths(paths: string[]): AdmissionCandidate[] {
  return paths.flatMap((path) => {
    const m = SUBMISSION.exec(path);
    return m
      ? [
          {
            publicationId: m[1]!,
            postId: m[2]!,
            workflowKey: `${m[1]}/${m[2]}@${m[3]!.slice(0, 32)}`,
            source: "submission" as const,
          },
        ]
      : [];
  });
}

export interface ReconcileReport {
  /** Distinct posts found with an earlier automatic run. */
  posts: number;
  /** Admissions recorded now (or that would be, without `apply`). */
  recorded: number;
  /** Posts that already had an admission. */
  alreadyAdmitted: number;
}

/**
 * Record one admission per post that already ran. Submission records come
 * first, then Restate keys; within each, keys sort for a stable choice.
 */
export function reconcileAdmissions(
  operations: Pick<OperationStore, "reconcileAutomaticAdmission" | "automaticAdmission">,
  candidates: AdmissionCandidate[],
  options: { apply: boolean },
): ReconcileReport {
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(a.source === "restate") - Number(b.source === "restate") ||
      a.workflowKey.localeCompare(b.workflowKey),
  );
  const seen = new Set<string>();
  const report: ReconcileReport = { posts: 0, recorded: 0, alreadyAdmitted: 0 };
  for (const c of ordered) {
    const post = `${c.publicationId}/${c.postId}`;
    if (seen.has(post)) continue;
    seen.add(post);
    report.posts++;
    if (operations.automaticAdmission(c.publicationId, c.postId)) {
      report.alreadyAdmitted++;
      continue;
    }
    if (!options.apply || operations.reconcileAutomaticAdmission(c)) report.recorded++;
  }
  return report;
}
