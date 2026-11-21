import { z } from "zod";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { PackageVerificationReportSchema } from "../drafting/package-verify.js";

/**
 * Bounded read-only review history for one post (#499).
 *
 * Every saved verifier pass is listed in chronological order, including the
 * final `unresolved` wrapper, so an owner can see the whole bounded revision
 * chain rather than only the last aggregate verdict. Saved model revisions are
 * immutable: reads never re-verify, re-deliver or invent a pass, and a missing
 * or unreadable report is reported rather than inferred as a completed review.
 */

export const REVIEW_PAGE = 20;
export const REVIEW_SCAN = 200;
const LIST_PAGE = 50;
const REPORT_PATH = /^verifications\/([^/]+)\/([^/]+)\/[^/]+\.json$/;

const UnresolvedWrapperSchema = z
  .object({
    outcome: z.literal("unresolved"),
    revisions: z.number().int().min(0),
    report: z
      .object({ repository: z.string(), commit: z.string(), path: z.string(), hash: z.string() })
      .strict(),
    issues: z.array(z.unknown()),
  })
  .strict();

export interface ReviewIssue {
  passage: string;
  reason: string;
  severity: "substantive" | "minor";
}

export type ReviewEntry =
  | {
      kind: "review";
      /** Saved report path; stable identity. */
      path: string;
      outcome: "approved" | "redraft";
      verifiedAt: string;
      draft: { repository: string; commit: string; path: string; hash: string };
      modelVersion?: string;
      promptVersion?: string;
      /** `publication` when the report binds a structured payload, else `body-only`. */
      scope: "publication" | "body-only";
      issues: ReviewIssue[];
      checks: string[];
    }
  | {
      kind: "unresolved";
      path: string;
      outcome: "unresolved";
      revisions: number;
      /** The terminal report this wrapper points at. */
      reportPath: string;
      issues: ReviewIssue[];
    }
  | { kind: "unreadable"; path: string };

export interface EditorialDecisionView {
  path: string;
  action: "approve" | "reject" | "feedback";
  decidedAt: string;
  draftHash?: string;
  comment?: string;
}

export interface ReviewHistory {
  state: "ok" | "none" | "partial" | "unavailable";
  /** Newest first, bounded to REVIEW_PAGE. */
  reviews: ReviewEntry[];
  editorial: EditorialDecisionView[];
  /** Cursor for the next page, when more saved reports exist. */
  next?: number;
  /** True when the bounded scan could not examine every saved report. */
  truncated: boolean;
}

export interface ReviewHistoryPort {
  forPost(post: { publicationId: string; postId: string }, page?: number): Promise<ReviewHistory>;
}

type Store = Pick<GitArtifactStore, "list" | "lookup" | "read">;

const asIssues = (issues: unknown): ReviewIssue[] => {
  if (!Array.isArray(issues)) return [];
  const out: ReviewIssue[] = [];
  for (const issue of issues) {
    if (issue === null || typeof issue !== "object") continue;
    const record = issue as { passage?: unknown; reason?: unknown; severity?: unknown };
    if (typeof record.passage !== "string" || typeof record.reason !== "string") continue;
    out.push({
      passage: record.passage,
      reason: record.reason,
      severity: record.severity === "minor" ? "minor" : "substantive",
    });
  }
  return out;
};

const asDecision = (raw: unknown): EditorialDecisionView | undefined => {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as {
    action?: unknown;
    decidedAt?: unknown;
    comment?: unknown;
    draft?: { hash?: unknown };
  };
  if (r.action !== "approve" && r.action !== "reject" && r.action !== "feedback") return undefined;
  if (typeof r.decidedAt !== "string") return undefined;
  return {
    path: "",
    action: r.action,
    decidedAt: r.decidedAt,
    ...(typeof r.draft?.hash === "string" ? { draftHash: r.draft.hash } : {}),
    ...(typeof r.comment === "string" ? { comment: r.comment } : {}),
  };
};

export function savedReviews(content: Store): ReviewHistoryPort {
  return {
    async forPost(post, page = 0) {
      const start = Number.isInteger(page) && page >= 0 ? page : 0;
      let paths: string[] = [];
      let truncated = false;
      let unreadableListing = false;
      let after: string | undefined;
      for (let calls = 0; calls < 10; calls++) {
        let batch: string[];
        try {
          batch = await content.list(
            `verifications/${post.publicationId}/${post.postId}`,
            LIST_PAGE,
            after,
          );
        } catch {
          unreadableListing = true;
          break;
        }
        paths.push(...batch);
        if (batch.length < LIST_PAGE) break;
        if (paths.length >= REVIEW_SCAN) {
          truncated = true;
          break;
        }
        after = batch.at(-1);
      }
      if (unreadableListing && paths.length === 0) {
        return { state: "unavailable", reviews: [], editorial: [], truncated: false };
      }
      if (paths.length > REVIEW_SCAN) {
        paths = paths.slice(0, REVIEW_SCAN);
        truncated = true;
      }

      const parsed: ReviewEntry[] = [];
      let unreadableReports = 0;
      for (const path of paths) {
        if (!REPORT_PATH.test(path)) continue;
        let raw: unknown;
        try {
          const ref = await content.lookup(path);
          if (!ref) continue;
          raw = JSON.parse(await content.read(ref));
        } catch {
          parsed.push({ kind: "unreadable", path });
          unreadableReports++;
          continue;
        }
        const report = PackageVerificationReportSchema.safeParse(raw);
        if (report.success) {
          const r = report.data;
          parsed.push({
            kind: "review",
            path,
            outcome: r.outcome,
            verifiedAt: r.verifiedAt,
            draft: r.draft,
            modelVersion: r.verifierModel,
            promptVersion: r.promptVersion,
            scope: "publication" in r ? "publication" : "body-only",
            issues: asIssues(r.issues),
            checks: r.checks,
          });
          continue;
        }
        const wrapper = UnresolvedWrapperSchema.safeParse(raw);
        if (wrapper.success) {
          parsed.push({
            kind: "unresolved",
            path,
            outcome: "unresolved",
            revisions: wrapper.data.revisions,
            reportPath: wrapper.data.report.path,
            issues: asIssues(raw && (raw as { issues?: unknown }).issues),
          });
          continue;
        }
        parsed.push({ kind: "unreadable", path });
        unreadableReports++;
      }

      // Chronological by the saved instant; stable path tie-break. The wrapper
      // has no timestamp of its own, so it keeps its path order among reviews.
      const when = (e: ReviewEntry) => (e.kind === "review" ? Date.parse(e.verifiedAt) : NaN);
      parsed.sort((a, b) => {
        const ta = when(a);
        const tb = when(b);
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
        return b.path.localeCompare(a.path);
      });

      const editorial: EditorialDecisionView[] = [];
      try {
        const decisionPaths = await content.list(
          `editorial-decisions/${post.publicationId}/${post.postId}`,
          100,
        );
        for (const path of decisionPaths) {
          if (!path.endsWith(".json")) continue;
          try {
            const ref = await content.lookup(path);
            if (!ref) continue;
            const view = asDecision(JSON.parse(await content.read(ref)));
            if (view) editorial.push({ ...view, path });
          } catch {
            // An unreadable manual decision is omitted, not guessed.
          }
        }
      } catch {
        // No decisions directory is simply no manual decisions.
      }
      editorial.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));

      const startIndex = start * REVIEW_PAGE;
      const reviews = parsed.slice(startIndex, startIndex + REVIEW_PAGE);
      const next = parsed.length > startIndex + REVIEW_PAGE ? start + 1 : undefined;
      const state =
        parsed.length === 0
          ? truncated || unreadableReports > 0
            ? "partial"
            : "none"
          : truncated || unreadableReports > 0
            ? "partial"
            : "ok";
      return {
        state,
        reviews,
        editorial,
        ...(next === undefined ? {} : { next }),
        truncated,
      };
    },
  };
}
