import { z } from "zod";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import { PackageVerificationReportSchema } from "../drafting/package-verify.js";
import { readPublicationPayload } from "../drafting/publication-payload.js";

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
/** Bound on manual editorial decisions scanned for one history page. */
export const EDITORIAL_SCAN = 200;
const LIST_PAGE = 50;
const REPORT_PATH = /^verifications\/([^/]+)\/([^/]+)\/[^/]+\.json$/;

/**
 * Reports written by the earlier `VerificationWorker` (`src/drafting/verify.ts`)
 * share the directory but use a different contract: `verdict`, `brief` and
 * `problem`/`requiredChange` issues. They are valid saved reviews and are
 * adapted, not reported as corrupt.
 */
const WorkerVerificationSchema = z
  .object({
    schemaVersion: z.literal(1),
    verdict: z.enum(["approve", "redraft", "skip"]),
    draft: z.object({ path: z.string(), commit: z.string(), hash: z.string() }).strict(),
    brief: z.object({ path: z.string(), commit: z.string(), hash: z.string() }).strict(),
    issues: z
      .array(
        z
          .object({
            source: z.enum(["deterministic", "verifier"]).optional(),
            passage: z.string().optional(),
            problem: z.string(),
            requiredChange: z.string(),
          })
          .strict(),
      ),
    attempt: z.number().int().min(0),
    maxAttempts: z.number().int().min(0),
    verifier: z
      .object({ modelVersion: z.string(), promptVersion: z.string() })
      .strict()
      .optional(),
    rejectedIssues: z.number().int().min(0),
    contextRef: z.string().optional(),
  })
  .loose();

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
      outcome: "approved" | "redraft" | "skip";
      verifiedAt?: string;
      draft: { repository?: string; commit: string; path: string; hash: string };
      modelVersion?: string;
      promptVersion?: string;
      /** Derived from the pinned payload; `unknown` when it cannot be read. */
      scope: "publication" | "body-only" | "unknown";
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
      let payloadUnreadable = 0;
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
          // A schema-v2 report can still cover only a legacy body, so the
          // pinned payload's mode decides the scope, not the property.
          let scope: "publication" | "body-only" | "unknown" = "body-only";
          if ("publication" in r) {
            try {
              const { payload } = await readPublicationPayload(content, r.publication);
              scope = payload.mode === "structured" ? "publication" : "body-only";
            } catch {
              // A missing/corrupt payload does not prove a legacy body: keep the
              // scope unknown and mark the history incomplete.
              scope = "unknown";
              payloadUnreadable++;
            }
          }
          parsed.push({
            kind: "review",
            path,
            outcome: r.outcome,
            verifiedAt: r.verifiedAt,
            draft: r.draft,
            modelVersion: r.verifierModel,
            promptVersion: r.promptVersion,
            scope,
            issues: asIssues(r.issues),
            checks: r.checks,
          });
          continue;
        }
        const worker = WorkerVerificationSchema.safeParse(raw);
        if (worker.success) {
          const w = worker.data;
          parsed.push({
            kind: "review",
            path,
            outcome:
              w.verdict === "approve" ? "approved" : w.verdict === "skip" ? "skip" : "redraft",
            draft: {
              commit: w.draft.commit,
              path: w.draft.path,
              hash: w.draft.hash,
            },
            ...(w.verifier ? { modelVersion: w.verifier.modelVersion } : {}),
            ...(w.verifier ? { promptVersion: w.verifier.promptVersion } : {}),
            scope: "body-only",
            issues: w.issues.map((issue) => ({
              passage: issue.passage ?? "",
              reason: `${issue.problem} → ${issue.requiredChange}`,
              severity: "substantive" as const,
            })),
            checks: ["worker-verification"],
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

      // One total order for every entry: the saved instant of the report it
      // represents. A wrapper takes its referenced report's timestamp (path
      // lexicographic order says nothing about time); unreadable or unknown
      // entries get 0 and sort last, deterministically by path.
      const at = new Map<string, number>();
      for (const entry of parsed) {
        if (entry.kind === "review") {
          const parsedAt = entry.verifiedAt === undefined ? 0 : Date.parse(entry.verifiedAt);
          at.set(entry.path, Number.isFinite(parsedAt) ? parsedAt : 0);
          continue;
        }
        if (entry.kind === "unresolved") {
          let found = 0;
          try {
            const ref = await content.lookup(entry.reportPath);
            if (ref) {
              const inner = PackageVerificationReportSchema.safeParse(
                JSON.parse(await content.read(ref)),
              );
              if (inner.success) {
                const parsedAt = Date.parse(inner.data.verifiedAt);
                if (Number.isFinite(parsedAt)) found = parsedAt;
              }
            }
          } catch {
            // Unknown age: sorted with the other untimestamped entries.
          }
          at.set(entry.path, found);
          continue;
        }
        at.set(entry.path, 0);
      }
      parsed.sort((a, b) => {
        const ta = at.get(a.path) ?? 0;
        const tb = at.get(b.path) ?? 0;
        if (ta !== tb) return tb - ta;
        return b.path.localeCompare(a.path);
      });

      const editorial: EditorialDecisionView[] = [];
      let editorialTruncated = false;
      let editorialIncomplete = false;
      const decisionPaths: string[] = [];
      let decisionAfter: string | undefined;
      for (let calls = 0; calls < 10; calls++) {
        let batch: string[];
        try {
          batch = await content.list(
            `editorial-decisions/${post.publicationId}/${post.postId}`,
            LIST_PAGE,
            decisionAfter,
          );
        } catch {
          // A missing directory lists as empty; an exception is a storage
          // failure, so collected decisions are not the whole story.
          if (calls > 0 || decisionPaths.length > 0) editorialIncomplete = true;
          break;
        }
        decisionPaths.push(...batch);
        if (batch.length < LIST_PAGE) break;
        if (decisionPaths.length >= EDITORIAL_SCAN) {
          editorialTruncated = true;
          break;
        }
        decisionAfter = batch.at(-1);
      }
      for (const path of decisionPaths.slice(0, EDITORIAL_SCAN)) {
        if (!path.endsWith(".json")) continue;
        try {
          const ref = await content.lookup(path);
          if (!ref) continue;
          const view = asDecision(JSON.parse(await content.read(ref)));
          if (view) editorial.push({ ...view, path });
        } catch {
          // An unreadable manual decision is omitted, but the history says so.
          editorialIncomplete = true;
        }
      }
      editorial.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));

      const startIndex = start * REVIEW_PAGE;
      const reviews = parsed.slice(startIndex, startIndex + REVIEW_PAGE);
      const next = parsed.length > startIndex + REVIEW_PAGE ? start + 1 : undefined;
      const incomplete =
        truncated ||
        unreadableReports > 0 ||
        unreadableListing ||
        payloadUnreadable > 0 ||
        editorialTruncated ||
        editorialIncomplete;
      const state =
        parsed.length === 0 ? (incomplete ? "partial" : "none") : incomplete ? "partial" : "ok";
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
