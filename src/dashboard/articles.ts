import type { PostTrace } from "../diagnostics/post-trace.js";
import { postCorrelationId } from "../observability/post-correlation.js";
import { articleRunKey, type ArticleRunFinal, type Ref } from "../workflow/article-run.js";
import { recoveryWorkflowKey } from "./recovery.js";
import type { ArticleThemes, ThemesPort } from "./themes.js";
import type { ArticleClaims, ClaimsPort } from "./claims.js";

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

export type ArticleSort = "newest" | "oldest";

export interface ArticlePage {
  entries: ArchivedArticle[];
  /** Opaque cursor for the next page; absent when the listing is exhausted. */
  next?: string;
}

export interface RecentArticlesPort {
  recent(limit: number): Promise<ArchivedArticle[]>;
  /** The indexed revision of one post, or undefined when it is not indexed. */
  find(publicationId: string, postId: string): Promise<ArchivedArticle | undefined>;
  /**
   * Bounded, ordered paging across the whole collection (#508). Optional so a
   * port that only offers `recent` still works: the view then says the full
   * listing is unavailable rather than pretending to page.
   */
  page?(options: {
    sort: ArticleSort;
    after?: string;
    limit: number;
    /** Plain words matched over the indexed title and text (#509). */
    query?: string;
    /** Exact publication filter (#509). */
    publicationId?: string;
  }): Promise<ArticlePage>;
}

export type RunState = (
  | { state: "not-started" }
  | {
      state: "running";
      /** The run's own durable progress (#439); null before its first stage, absent if unreadable. */
      progress?: {
        stage: string;
        status: "running" | "completed";
        at: string;
        phase?: string;
        round?: number;
      } | null;
    }
  | {
      state: "finished";
      result: ArticleRunFinal;
      /** The recorded recovery run for this revision, when one was started (#480). */
      recovery?: RunState;
    }
  | { state: "unavailable" }
  | { state: "not-configured" }
) & {
  workflowKey?: string;
  attempts?: Array<{ workflowKey: string; requestId: string; recordedAt: string }>;
};

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
  publicationHash?: string;
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
  /** A verification report, or the report inside an unresolved wrapper. */
  verification(
    ref: Ref,
  ): Promise<{ outcome: string; draftHash?: string; publicationHash?: string } | undefined>;
}

/**
 * Retained captured source for the article page (#446): the exact archived
 * record, never a fresh fetch. Text is untrusted and is escaped at render.
 */
export type CapturedSource =
  | {
      state: "recorded";
      title?: string;
      url?: string;
      method: string;
      complete: boolean;
      sourceVersion: string;
      /** Logical revision the record was read from (`shortcommit:path`). */
      revision: string;
      text: string;
      truncated: boolean;
      /** False when the selected run/archive version differs from this text. */
      matchesRevision: boolean | null;
    }
  | { state: "missing" | "unreadable" | "not-configured" | "unsupported" };

export interface SourcePort {
  read(
    post: { publicationId: string; postId: string },
    expectedSourceVersion?: string,
  ): Promise<CapturedSource>;
}

/** Delivery receipts recorded for one article and revision. */
export interface ReceiptsResult {
  receipts: ReceiptView[];
  /** True when the scan bound was reached before the store was exhausted. */
  truncated: boolean;
}

export interface ReceiptsPort {
  receiptsFor(
    post: { publicationId: string; postId: string },
    draftHash?: string,
    publicationHash?: string,
  ): Promise<ReceiptsResult>;
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

/** Editorial meaning of a finished workflow, separate from its termination (#486). */
export type EditorialOutcome = "verified" | "rejected" | "evidence-gap" | "unverified" | "none";

export function editorialOutcomeOf(outcome: ArticleRunFinal["outcome"]): EditorialOutcome {
  switch (outcome) {
    case "verified":
      return "verified";
    case "rejected":
      return "rejected";
    case "evidence-gap":
      return "evidence-gap";
    case "drafted-unverified":
      return "unverified";
    default:
      return "none";
  }
}

export interface ArticleTrace {
  post: { publicationId: string; postId: string };
  correlationId: string;
  workflowKey?: string;
  attempts?: Array<{ workflowKey: string; requestId: string; recordedAt: string }>;
  sourceVersion?: string;
  summary: RunSummary;
  /** What the workflow concluded editorially; `none` for failures and pending work. */
  editorial: EditorialOutcome;
  /** True only when a dispatch approval handoff was actually recorded. */
  approvalRecorded?: boolean;
  /** When a running workflow last reported progress (#439). */
  lastUpdate?: string;
  outcome?: string;
  reason?: string;
  stages: StageRow[];
  research: Array<{ jobId: string; outcome: string }>;
  trace?: PostTrace;
  draft?: DraftView;
  verification?: VerificationView;
  receipts: ReceiptView[];
  /** True when the receipt scan could not be completed within its bound. */
  receiptsTruncated: boolean;
  /** Retained captured source for this post (#446). */
  source: CapturedSource;
  /** Saved theme proposals for exactly this revision (#496). */
  themes?: ArticleThemes;
  /** Saved claim occurrences for exactly this revision (#497). */
  claims?: ArticleClaims;
  /** Latest recorded recovery run for this revision (#480), when started. */
  recovery?: {
    summary: RunSummary;
    outcome?: string;
    reason?: string;
    /** Exact recovery workflow identity. */
    workflowKey?: string;
    /** Stage progress while the recovery is still running. */
    progress?: { stage: string; status: "running" | "completed"; at: string } | null;
    /** The recovery's own saved artifacts, never the original run's. */
    draft?: DraftView;
    verification?: VerificationView;
    receipts?: ReceiptView[];
    receiptsTruncated?: boolean;
  };
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
  "plan-research": "research",
  coverage: "research",
  package: "drafting",
  draft: "drafting",
  drafting: "drafting",
  verify: "verification",
  editorial: "verification",
  assessment: "verification",
  judgment: "verification",
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
/** The workflow step that completes each dashboard stage (#439). */
const LAST_STEP: Partial<Record<StageName, string>> = {
  themes: "themes",
  claims: "claims",
  research: "coverage",
  drafting: "draft",
  verification: "verify",
  delivery: "record-approval",
};

/** A running stage with no progress update for this long is shown as stalled. */
export const STALL_MS = 30 * 60_000;

export function summariseRun(
  run: RunState,
  now: number = Date.now(),
): Pick<
  ArticleTrace,
  | "summary"
  | "editorial"
  | "approvalRecorded"
  | "outcome"
  | "reason"
  | "stages"
  | "research"
  | "lastUpdate"
> {
  const idx = (s: StageName) => STAGES.indexOf(s);
  switch (run.state) {
    case "not-configured":
    case "unavailable":
      return {
        summary: "unknown",
        editorial: "none",
        stages: STAGES.map((stage) => ({ stage, state: "unknown", detail: run.state })),
        research: [],
      };
    case "not-started":
      return {
        summary: "not-started",
        editorial: "none",
        stages: rows(idx("themes")),
        research: [],
      };
    case "running": {
      // Progress comes from the run's own durable state (#439). Missing or
      // stale progress is shown as such, never as success.
      const p = run.progress;
      if (!p) {
        return {
          summary: "pending",
          editorial: "none",
          stages: rows(idx("themes"), {
            state: "pending",
            detail: p === null ? "starting" : "progress unavailable",
          }),
          research: [],
        };
      }
      const named = STAGE_ALIASES[p.stage];
      if (!named) {
        return {
          summary: "pending",
          editorial: "none",
          stages: rows(idx("themes"), { state: "pending", detail: "progress unrecognised" }),
          research: [],
        };
      }
      // A dashboard stage groups several workflow steps; it is done only when
      // its last step completes (coverage for research, draft for drafting).
      const finishesGroup =
        p.status === "completed" && (LAST_STEP[named] === p.stage || p.stage === "editorial");
      const at = idx(named) + (finishesGroup ? 1 : 0);
      const current = Math.min(at, STAGES.length - 1);
      const age = now - Date.parse(p.at);
      const when = p.at.slice(0, 19).replace("T", " ");
      const detail =
        Number.isNaN(age) || age > STALL_MS
          ? `stalled: no update since ${when} UTC`
          : `${p.stage}${p.phase ? ` ${p.phase}` : ""}${p.round === undefined ? "" : ` pass ${p.round + 1}`} ${p.status === "running" ? "in progress" : "done"} at ${when} UTC`;
      return {
        summary: "pending",
        editorial: "none",
        lastUpdate: p.at,
        stages: rows(current, { state: "pending", detail }),
        research: [],
      };
    }
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
          editorial: "none",
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
        return {
          summary: "completed",
          editorial: editorialOutcomeOf(r.outcome),
          ...base,
          stages,
        };
      }
      if (r.outcome === "drafted-unverified") {
        const stages = rows(idx("verification"));
        stages[idx("verification")] = {
          stage: "verification",
          state: "not-reached",
          detail: reason ?? "unverified",
        };
        return {
          summary: "completed",
          editorial: editorialOutcomeOf(r.outcome),
          ...base,
          stages,
        };
      }
      const verified = r.outcome === "verified";
      const approvalRecorded = "approvalEvent" in r && Boolean(r.approvalEvent);
      const stages = rows(idx("delivery"));
      stages[idx("verification")] = {
        stage: "verification",
        state: verified ? "done" : "failed",
        detail: verified ? "approved" : `rejected${reason ? `: ${reason}` : ""}`,
      };
      stages[idx("delivery")] = approvalRecorded
        ? { stage: "delivery", state: "done", detail: "approval recorded for dispatch" }
        : { stage: "delivery", state: "not-reached" };
      return {
        summary: "completed",
        editorial: editorialOutcomeOf(r.outcome),
        approvalRecorded,
        ...base,
        stages,
      };
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
  /** Retained captured source (#446). */
  source?: SourcePort;
  /** Saved theme proposals for this exact revision (#496). */
  themes?: ThemesPort;
  /** Saved claims for this exact revision (#497). */
  claims?: ClaimsPort;
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
  // Always report a state, so an unconfigured archive is distinguishable from
  // a page that simply omits the feature.
  let source: CapturedSource = { state: "not-configured" };
  if (input.source) {
    try {
      source = await input.source.read(post, sourceVersion);
    } catch {
      source = { state: "unreadable" };
    }
  }
  // Themes are listed whenever the revision is known, independent of the run.
  let themes: ArticleThemes | undefined;
  if (input.themes && sourceVersion) {
    try {
      themes = await input.themes.forPost(post, sourceVersion);
    } catch {
      themes = { state: "unavailable", themes: [] };
    }
  }
  // Claims are listed for the same exact revision, from the saved extraction.
  let claims: ArticleClaims | undefined;
  if (input.claims && sourceVersion) {
    try {
      claims = await input.claims.forPost(post, sourceVersion);
    } catch {
      claims = {
        state: "unavailable",
        accepted: [],
        legacy: [],
        candidates: [],
        rejected: [],
      };
    }
  }
  const summary = summariseRun(run);

  // Projection of one run's own artifacts. Used for the original run and for
  // its recovery, so a successful recovery shows its own draft, verification
  // and receipts rather than the failed run's.
  const project = async (result: ArticleRunFinal) => {
    let draft: DraftView | undefined;
    if ("draft" in result && result.draft && input.content) {
      try {
        const text = await input.content.draft(result.draft);
        if (text !== undefined) draft = { hash: result.draft.sha256, text };
      } catch {
        draft = undefined;
      }
    }
    let verification: VerificationView | undefined;
    if ("verification" in result && result.verification && input.content) {
      try {
        const report = await input.content.verification(result.verification);
        if (report) {
          verification = {
            outcome: report.outcome,
            matchesDraft:
              draft !== undefined &&
              report.draftHash !== undefined &&
              report.draftHash === `sha256:${draft.hash}`,
            ...(report.draftHash ? { draftHash: report.draftHash } : {}),
            ...(report.publicationHash ? { publicationHash: report.publicationHash } : {}),
          };
        }
      } catch {
        verification = undefined;
      }
    }
    const runDraftHash = "draft" in result && result.draft ? result.draft.sha256 : undefined;
    let receipts: ReceiptView[] = [];
    let receiptsTruncated = false;
    if (input.receipts && runDraftHash) {
      try {
        const found = await input.receipts.receiptsFor(
          post,
          `sha256:${runDraftHash}`,
          verification?.publicationHash,
        );
        receipts = found.receipts;
        receiptsTruncated = found.truncated;
      } catch {
        receipts = [];
      }
    }
    return { draft, verification, receipts, receiptsTruncated };
  };

  const empty = {
    draft: undefined as DraftView | undefined,
    verification: undefined as VerificationView | undefined,
    receipts: [] as ReceiptView[],
    receiptsTruncated: false,
  };
  const finished = run.state === "finished" ? run.result : undefined;
  const own = finished ? await project(finished) : empty;

  // The recovery is shown alongside the original failure, with its own exact
  // identity, progress and final artifacts.
  let recovery: ArticleTrace["recovery"];
  if (run.state === "finished" && run.recovery) {
    const r = run.recovery;
    const recovered = summariseRun(r);
    const artifacts = r.state === "finished" ? await project(r.result) : empty;
    recovery = {
      summary: recovered.summary,
      workflowKey:
        sourceVersion === undefined
          ? undefined
          : recoveryWorkflowKey(articleRunKey({ ...post, sourceVersion })),
      ...(recovered.outcome ? { outcome: recovered.outcome } : {}),
      ...(recovered.reason ? { reason: recovered.reason } : {}),
      ...(r.state === "running" ? { progress: r.progress ?? null } : {}),
      ...(artifacts.draft ? { draft: artifacts.draft } : {}),
      ...(artifacts.verification ? { verification: artifacts.verification } : {}),
      ...(artifacts.receipts.length > 0 ? { receipts: artifacts.receipts } : {}),
      ...(artifacts.receiptsTruncated ? { receiptsTruncated: true } : {}),
    };
  }

  return {
    post,
    ...(run.workflowKey ? { workflowKey: run.workflowKey } : {}),
    ...(run.attempts ? { attempts: run.attempts } : {}),
    correlationId: postCorrelationId(post),
    ...(sourceVersion ? { sourceVersion } : {}),
    ...summary,
    ...(trace ? { trace } : {}),
    ...(own.draft ? { draft: own.draft } : {}),
    ...(own.verification ? { verification: own.verification } : {}),
    receipts: own.receipts,
    receiptsTruncated: own.receiptsTruncated,
    source,
    ...(themes ? { themes } : {}),
    ...(claims ? { claims } : {}),
    ...(recovery ? { recovery } : {}),
  };
}
