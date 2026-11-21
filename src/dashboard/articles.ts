import type { PostTrace } from "../diagnostics/post-trace.js";
import { postCorrelationId } from "../observability/post-correlation.js";
import type { ArticleRunFinal, Ref } from "../workflow/article-run.js";

/**
 * Archived articles and their runs, for the dashboard (#377).
 *
 * Recent articles come from the full-text index, which mirrors the archive
 * and can be ordered by publication date. A selected revision is traced
 * through the existing post trace (#174: capture, index, themes, claims) and
 * the ArticleRun workflow's own result for that exact revision (research,
 * drafting, verification and the approval that starts delivery). Delivery
 * receipts themselves are shown by #378.
 *
 * Read-only. Failure reasons are reduced to a short allowlisted token, so no
 * paths, URLs, hosts or payloads reach the page. The correlation ID is the
 * same one the pipeline logs carry.
 */

export interface ArchivedArticle {
  publicationId: string;
  postId: string;
  title?: string;
  publishedAt?: string;
  sourceVersion: string;
}

export interface RecentArticlesPort {
  recent(limit: number): Promise<ArchivedArticle[]>;
  /** The indexed revision of one post, or undefined when it is not indexed. */
  find(publicationId: string, postId: string): Promise<ArchivedArticle | undefined>;
}

export type RunState =
  | { state: "not-started" }
  | { state: "running" }
  | { state: "finished"; result: ArticleRunFinal }
  | { state: "unavailable" }
  | { state: "not-configured" };

/** Content for one saved draft (markdown, untrusted) and its exact hash. */
export interface DraftView {
  hash: string;
  text: string;
}

/** Verifier outcome bound to the exact draft revision it checked. */
export interface VerificationView {
  outcome: string;
  /** True only when the report's draft hash equals the run's saved draft. */
  matchesDraft: boolean;
  draftHash?: string;
}

/** One publisher/destination receipt for an approved revision. */
export interface ReceiptView {
  destination: string;
  action: string;
  simulated: boolean;
  deliveredAt: string;
  /** Present only for a confirmed real delivery over HTTPS. */
  url?: string;
}

/** Reads saved drafts and verification reports through the artifact controller. */
export interface ArticleContentPort {
  draft(ref: Ref): Promise<string | undefined>;
  verification(ref: Ref): Promise<{ outcome: string; draftHash?: string } | undefined>;
}

/** Delivery receipts recorded for one article. */
export interface ReceiptsPort {
  receiptsFor(
    post: { publicationId: string; postId: string },
    draftHash?: string,
  ): Promise<ReceiptView[]>;
}

export interface RunStatusPort {
  /** The ArticleRun workflow for this exact revision. */
  status(post: { publicationId: string; postId: string; sourceVersion: string }): Promise<RunState>;
}

export const STAGES = [
  "capture",
  "themes",
  "claims",
  "research",
  "drafting",
  "verification",
  "delivery",
] as const;
export type StageName = (typeof STAGES)[number];

export type StageState = "done" | "failed" | "pending" | "not-reached" | "unknown";

export interface StageRow {
  stage: StageName;
  state: StageState;
  detail?: string;
}

export type RunSummary = "completed" | "failed" | "pending" | "not-started" | "unknown";

export interface ArticleTrace {
  post: { publicationId: string; postId: string };
  correlationId: string;
  sourceVersion?: string;
  summary: RunSummary;
  outcome?: string;
  reason?: string;
  stages: StageRow[];
  research: Array<{ jobId: string; outcome: string }>;
  trace?: PostTrace;
  draft?: DraftView;
  verification?: VerificationView;
  receipts: ReceiptView[];
}

/** Fixed reasons the workflow itself produces, shown as they are. */
const KNOWN_REASONS = new Set([
  "invalid-input",
  "draft-failed",
  "evidence-gap",
  "no verifier model configured",
]);
const CODE = /^[a-z0-9]+(?:-[a-z0-9]+){0,8}$/;
export const UNRECOGNISED_REASON = "unrecognised failure (see local logs by correlation ID)";

/**
 * Map a workflow failure reason to an allowlisted category. Only known fixed
 * reasons, `<stage>: <kebab-case code>` for a known stage, and the bounded
 * redraft count pass; anything else (which could carry a host, address, path
 * or credential) becomes a fixed fallback. Dots and slashes never pass.
 */
export function sanitizeReason(reason: string): string {
  const r = reason.trim().toLowerCase();
  if (KNOWN_REASONS.has(r)) return r;
  if (/^unresolved after [0-9]{1,2} redrafts$/.test(r)) return r;
  const m = /^([a-z-]+): ([a-z0-9-]+)$/.exec(r);
  if (m && m[1]! in STAGE_ALIASES && CODE.test(m[2]!)) return r;
  if (CODE.test(r) && r.length <= 60) return r;
  return UNRECOGNISED_REASON;
}

const STAGE_ALIASES: Record<string, StageName> = {
  source: "capture",
  capture: "capture",
  themes: "themes",
  claims: "claims",
  research: "research",
  coverage: "research",
  package: "drafting",
  draft: "drafting",
  drafting: "drafting",
  verify: "verification",
  verification: "verification",
  approve: "delivery",
  "record-approval": "delivery",
};

/**
 * Stages before `upTo` are done. With `failed`, the stage at `upTo` failed;
 * with `pending`, it is in progress; otherwise it and later stages are not
 * reached.
 */
function rows(upTo: number, mark?: { state: "failed" | "pending"; detail?: string }): StageRow[] {
  return STAGES.map((stage, i): StageRow => {
    if (i < upTo) return { stage, state: "done" };
    if (i === upTo && mark)
      return { stage, state: mark.state, ...(mark.detail ? { detail: mark.detail } : {}) };
    return { stage, state: "not-reached" };
  });
}

/** Stage table and summary from the workflow's result for this revision. */
export function summariseRun(
  run: RunState,
): Pick<ArticleTrace, "summary" | "outcome" | "reason" | "stages" | "research"> {
  const idx = (s: StageName) => STAGES.indexOf(s);
  switch (run.state) {
    case "not-configured":
    case "unavailable":
      return {
        summary: "unknown",
        stages: STAGES.map((stage) => ({ stage, state: "unknown", detail: run.state })),
        research: [],
      };
    case "not-started":
      return { summary: "not-started", stages: rows(idx("themes")), research: [] };
    case "running":
      // The workflow's journal is not read here: running means "somewhere
      // after capture", shown as pending rather than guessed.
      return {
        summary: "pending",
        stages: rows(idx("themes"), { state: "pending" }),
        research: [],
      };
    case "finished": {
      const r = run.result;
      const research = r.research.map((j) => ({ jobId: j.jobId, outcome: j.outcome }));
      const reason = r.reason ? sanitizeReason(r.reason) : undefined;
      const base = { outcome: r.outcome, ...(reason ? { reason } : {}), research };
      if (r.outcome === "failed") {
        // A stage failure names its stage ("claims: provider-failed"); a
        // failure after packaging without a draft is a drafting failure.
        const named = STAGE_ALIASES[(r.reason ?? "").split(":")[0]!.trim()];
        const at = named
          ? idx(named)
          : "package" in r && r.package
            ? idx("drafting")
            : idx("themes");
        return {
          summary: "failed",
          ...base,
          stages: rows(at, { state: "failed", detail: reason ?? "failed" }),
        };
      }
      if (r.outcome === "evidence-gap") {
        const stages = rows(idx("drafting"));
        stages[idx("drafting")] = {
          stage: "drafting",
          state: "not-reached",
          detail: "evidence gap",
        };
        return { summary: "completed", ...base, stages };
      }
      if (r.outcome === "drafted-unverified") {
        const stages = rows(idx("verification"));
        stages[idx("verification")] = {
          stage: "verification",
          state: "not-reached",
          detail: reason ?? "unverified",
        };
        return { summary: "completed", ...base, stages };
      }
      const verified = r.outcome === "verified";
      const stages = rows(idx("delivery"));
      stages[idx("verification")] = {
        stage: "verification",
        state: verified ? "done" : "failed",
        detail: verified ? "approved" : `rejected${reason ? `: ${reason}` : ""}`,
      };
      stages[idx("delivery")] =
        "approvalEvent" in r && r.approvalEvent
          ? { stage: "delivery", state: "done", detail: "approval recorded for dispatch" }
          : { stage: "delivery", state: "not-reached" };
      return { summary: "completed", ...base, stages };
    }
  }
}

export async function traceArticle(input: {
  post: { publicationId: string; postId: string };
  articles?: RecentArticlesPort;
  runs?: RunStatusPort;
  /** The existing per-post trace (#174). */
  trace?: () => Promise<PostTrace>;
  /** Saved drafts and verification reports (#378). */
  content?: ArticleContentPort;
  /** Delivery receipts (#378). */
  receipts?: ReceiptsPort;
}): Promise<ArticleTrace> {
  const { post } = input;
  let article: ArchivedArticle | undefined;
  try {
    article = await input.articles?.find(post.publicationId, post.postId);
  } catch {
    article = undefined;
  }
  let trace: PostTrace | undefined;
  try {
    trace = await input.trace?.();
  } catch {
    trace = undefined;
  }
  // Prefer the archived revision; fall back to the indexed one.
  const sourceVersion =
    trace?.capture.archive.state === "recorded"
      ? trace.capture.archive.sourceVersion
      : article?.sourceVersion;
  let run: RunState = { state: "not-configured" };
  if (input.runs && sourceVersion) {
    try {
      run = await input.runs.status({ ...post, sourceVersion });
    } catch {
      run = { state: "unavailable" };
    }
  } else if (input.runs) {
    run = { state: "unavailable" };
  }
  const summary = summariseRun(run);
  const finished = run.state === "finished" ? run.result : undefined;
  let draft: DraftView | undefined;
  if (finished && "draft" in finished && finished.draft && input.content) {
    try {
      const text = await input.content.draft(finished.draft);
      if (text !== undefined) draft = { hash: finished.draft.sha256, text };
    } catch {
      draft = undefined;
    }
  }
  let verification: VerificationView | undefined;
  if (finished && "verification" in finished && finished.verification && input.content) {
    try {
      const report = await input.content.verification(finished.verification);
      if (report) {
        verification = {
          outcome: report.outcome,
          matchesDraft:
            draft !== undefined &&
            report.draftHash !== undefined &&
            report.draftHash === `sha256:${draft.hash}`,
          ...(report.draftHash ? { draftHash: report.draftHash } : {}),
        };
      }
    } catch {
      verification = undefined;
    }
  }
  // Receipts belong to the run's exact draft. Use the run result's own
  // reference even when reading the draft text failed, and show none when the
  // run has no draft at all: an earlier revision's delivery must never appear
  // under a run that produced nothing.
  const runDraftHash =
    finished && "draft" in finished && finished.draft ? finished.draft.sha256 : undefined;
  let receipts: ReceiptView[] = [];
  if (input.receipts && runDraftHash) {
    try {
      receipts = await input.receipts.receiptsFor(post, `sha256:${runDraftHash}`);
    } catch {
      receipts = [];
    }
  }
  return {
    post,
    correlationId: postCorrelationId(post),
    ...(sourceVersion ? { sourceVersion } : {}),
    ...summary,
    ...(trace ? { trace } : {}),
    ...(draft ? { draft } : {}),
    ...(verification ? { verification } : {}),
    receipts,
  };
}
