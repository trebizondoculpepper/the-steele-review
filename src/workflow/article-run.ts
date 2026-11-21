import { logPipeline } from "../observability/pipeline-log.js";
import * as restate from "@restatedev/restate-sdk";
import { articleRunTarget } from "../content/article-run-target.js";
export { articleRunTarget } from "../content/article-run-target.js";
import { z } from "zod";
import { researchJobId, type ResearchRequest } from "../research/job.js";
import type { CommissionedJob } from "../research/librarian.js";

/**
 * Unattended article run on Restate (#243).
 *
 * One `ArticleRun` workflow per captured post revision (key: publication,
 * post and source version) advances the existing TypeScript stages without a
 * person: themes → claims → librarian research plan → research fan-out with a
 * durable batch deadline → coverage → writer package → draft → verification.
 * Stages exchange exact Git artifact references; every external operation is
 * a journaled step, so a restarted worker resumes after the last completed
 * step and a redelivered trigger attaches to the same workflow instead of
 * starting another run.
 *
 * Research runs as durable calls to the `Research` service in the `research`
 * scope. A Restate concurrency rule on that scope (see
 * `RESEARCH_CONCURRENCY_RULE`) caps active research jobs across all article
 * runs; excess calls wait durably in Restate. The batch deadline starts at
 * submission, so queue time counts. At the deadline the workflow pins the
 * results it has; unfinished jobs become explicit timed-out gaps, and any
 * later result cannot change the pinned writer input.
 */

/** Plain-JSON artifact reference passed between stages. */
export interface Ref {
  repository: string;
  commit: string;
  path: string;
  sha256: string;
}

/** The exact captured item a run was started from (#270). */
export interface CapturedSource {
  /** `<kind>/<instance>`, e.g. `substack/saveusnow` or `blog/example-site`. */
  namespace: string;
  itemId: string;
  /** The exact archived capture record; stages read these bytes, hash-verified. */
  artifact: Ref;
}

export interface ArticleRunInput {
  /** Work identity used by the analysis stages; see `articleRunTarget`. */
  publicationId: string;
  postId: string;
  /** Present when started from a captured-content event; absent for Substack replay. */
  source?: CapturedSource;
  sourceVersion: string;
  /** Public link to the original post (for the article). */
  sourceUrl: string;
  /** Batch deadline for research, from submission, in milliseconds. */
  researchDeadlineMs: number;
  researchRequestLimit?: number;
}

export interface ArticleRunResult {
  outcome: "verified" | "rejected" | "drafted-unverified" | "evidence-gap" | "failed";
  reason?: string;
  themes: Ref;
  claims: Ref;
  coverage?: Ref;
  package?: Ref;
  draft?: Ref;
  verification?: Ref;
  research: { jobId: string; outcome: PinnedResearch["outcome"] }[];
  /** The approved-article event recorded for a verified draft (#262). */
  approvalEvent?: string;
}

/**
 * The existing stages, composed through their normal interfaces. Each must be
 * idempotent for the same inputs (they are content-addressed or reuse saved
 * results), because a crash after an external effect but before journaling
 * repeats the step.
 */
export interface ArticleStages {
  themes(post: ArticleRunInput): Promise<Ref>;
  claims(post: ArticleRunInput, themes: Ref): Promise<Ref>;
  /** The librarian's stable list of research requests for this analysis. */
  planResearch(themes: Ref, claims: Ref): Promise<ResearchRequest[]>;
  /** Run (or reuse) one research job. Called from the `Research` service. */
  research(request: ResearchRequest): Promise<CommissionedJob>;
  /** Librarian coverage from exactly the pinned research results. */
  coverage(themes: Ref, claims: Ref, pinned: PinnedResearch[]): Promise<Ref>;
  package(coverage: Ref): Promise<{ ref: Ref; status: "ready" | "evidence-gap" }>;
  draft(pkg: Ref, sourceUrl: string): Promise<{ ref?: Ref; failure?: string }>;
  /** Verify the exact draft against its package; `unavailable` when no verifier is configured. */
  verify(
    draft: Ref,
    pkg: Ref,
    sourceUrl: string,
  ): Promise<{ ref?: Ref; approved: boolean; unavailable?: string; draft?: Ref; reason?: string }>;
  /**
   * Hand an approving verification report to publishing: records one
   * approved-article event in the outbox (#262). Only called for approvals.
   */
  approve?(report: Ref): Promise<{ eventId: string }>;
}

/** A research job as pinned at the batch deadline. */
export type PinnedResearch =
  | { jobId: string; request: ResearchRequest; outcome: "finished"; job: CommissionedJob }
  | {
      jobId: string;
      request: ResearchRequest;
      outcome: "timed-out" | "failed" | "not-commissioned";
    };

export const RESEARCH_SCOPE = "research";
/** Admin API body (`PUT /limits/rules`) capping active research jobs across all runs. */
export const RESEARCH_CONCURRENCY_RULE = [
  {
    pattern: RESEARCH_SCOPE,
    limits: { concurrency: 2 },
    description: "Active Sonar research jobs (#243)",
  },
];

/** Stable workflow key for one captured post revision. */
export function articleRunKey(post: {
  publicationId: string;
  postId: string;
  sourceVersion: string;
}): string {
  return `${post.publicationId}/${post.postId}@${post.sourceVersion.replace(/^sha256:/, "").slice(0, 32)}`;
}

export function researchService(stages: Pick<ArticleStages, "research">) {
  return restate.service({
    name: "Research",
    handlers: {
      run: async (ctx: restate.Context, request: ResearchRequest): Promise<CommissionedJob> =>
        ctx.run("research", () => stages.research(request)),
    },
  });
}
export type ResearchServiceApi = ReturnType<typeof researchService>;

/** A deterministic stage failure (bad input, exhausted extraction): never retried. */
export class StageError extends Error {
  constructor(
    readonly stage: string,
    readonly reason: string,
  ) {
    super(`${stage}: ${reason}`);
    this.name = "StageError";
  }
}

/** Validated at the workflow boundary: requests can reach Restate without the CLI. */
export const ResearchRequestLimitSchema = z.number().int().nonnegative().max(100);

export const ArticleRunInputSchema = z
  .object({
    publicationId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    postId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
    sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    sourceUrl: z.url({ protocol: /^https$/ }),
    researchRequestLimit: ResearchRequestLimitSchema.optional(),
    researchDeadlineMs: z.number().int().min(1_000).max(86_400_000),
    source: z
      .object({
        namespace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}\/[a-z0-9][a-z0-9-]{0,99}$/),
        itemId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/),
        artifact: z
          .object({
            repository: z.string().min(1),
            commit: z.string().regex(/^[0-9a-f]{40,64}$/),
            path: z.string().min(1).max(500),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((input) => {
    if (!input.source) return true;
    const target = articleRunTarget(input.source.namespace, input.source.itemId);
    return target.publicationId === input.publicationId && target.postId === input.postId;
  }, "publication and post must match the captured source");

/** Transient stage failures are retried a bounded number of times. */
const STEP_RETRY = { maxRetryAttempts: 5 } as const;

export function articleRunWorkflow(stages: ArticleStages) {
  // Only the shape is used for typed calls; handlers run in the Research service.
  const Research = researchService(stages);

  async function runStages(
    ctx: restate.WorkflowContext,
    input: ArticleRunInput,
  ): Promise<ArticleRunResult> {
    // A StageError is deterministic: terminal, not retried; others retry boundedly.
    const step = <T>(name: string, fn: () => Promise<T>) =>
      ctx.run(
        name,
        async () => {
          try {
            const result = await fn();
            logPipeline(input, name, "completed", input.sourceVersion);
            return result;
          } catch (error) {
            logPipeline(input, name, "failed", input.sourceVersion);
            if (error instanceof StageError) throw new restate.TerminalError(error.message);
            throw error;
          }
        },
        STEP_RETRY,
      );

    // The deadline clock starts at submission: journaled once, fixed on replay.
    const submittedAt = await ctx.date.now();
    const deadline = submittedAt + input.researchDeadlineMs;

    const themes = await step("themes", () => stages.themes(input));
    const claims = await step("claims", () => stages.claims(input, themes));
    const requests = await step("plan-research", () => stages.planResearch(themes, claims));

    // Commission the configured prefix in librarian order. Restate limits concurrency separately.
    const pending = new Map<number, restate.RestatePromise<{ i: number; job?: CommissionedJob }>>();
    requests.slice(0, input.researchRequestLimit).forEach((request, i) => {
      const jobId = researchJobId(request);
      pending.set(
        i,
        ctx
          .scope(RESEARCH_SCOPE)
          .serviceClient(Research)
          .run(request, restate.rpc.opts({ idempotencyKey: jobId, limitKey: "sonar" }))
          // A research call that fails terminally is pinned as a failed job,
          // never allowed to fail the article run.
          .map((job, failure) => (failure ? { i } : { i, job: job! })),
      );
    });
    const harvested = new Map<number, CommissionedJob | null>();
    const remainingMs = deadline - (await ctx.date.now());
    if (pending.size > 0 && remainingMs > 0) {
      const timer = ctx
        .sleep(remainingMs, "research-deadline")
        .map(() => ({ i: -1, job: undefined }));
      while (pending.size > 0) {
        const next = await restate.RestatePromise.race([...pending.values(), timer]);
        if (next.i === -1) break; // deadline reached: pin what we have
        harvested.set(next.i, next.job ?? null);
        pending.delete(next.i);
      }
    }
    const pinned: PinnedResearch[] = requests.map((request, i) => {
      const jobId = researchJobId(request);
      if (input.researchRequestLimit !== undefined && i >= input.researchRequestLimit) {
        return { jobId, request, outcome: "not-commissioned" };
      }
      const job = harvested.get(i);
      if (job) return { jobId, request, outcome: "finished", job };
      return { jobId, request, outcome: job === null ? "failed" : "timed-out" };
    });
    for (const item of pinned) logPipeline(input, "research", item.outcome, input.sourceVersion);
    const research = pinned.map((p) => ({ jobId: p.jobId, outcome: p.outcome }));

    const coverage = await step("coverage", () => stages.coverage(themes, claims, pinned));
    const pkg = await step("package", () => stages.package(coverage));
    if (pkg.status !== "ready") {
      return { outcome: "evidence-gap", themes, claims, coverage, package: pkg.ref, research };
    }
    const drafted = await step("draft", () => stages.draft(pkg.ref, input.sourceUrl));
    if (!drafted.ref) {
      return {
        outcome: "failed",
        reason: drafted.failure ?? "draft-failed",
        themes,
        claims,
        coverage,
        package: pkg.ref,
        research,
      };
    }
    // Verification may redraft (bounded); the final draft is the one it judged.
    const verified = await step("verify", () =>
      stages.verify(drafted.ref!, pkg.ref, input.sourceUrl),
    );
    const finalDraft = verified.draft ?? drafted.ref;
    if (verified.unavailable) {
      return {
        outcome: "drafted-unverified",
        reason: verified.unavailable,
        themes,
        claims,
        coverage,
        package: pkg.ref,
        draft: finalDraft,
        research,
      };
    }
    // Only an approving verification is handed to publishing.
    const approval =
      verified.approved && verified.ref && stages.approve
        ? await step("record-approval", () => stages.approve!(verified.ref!))
        : undefined;
    return {
      outcome: verified.approved ? "verified" : "rejected",
      ...(approval ? { approvalEvent: approval.eventId } : {}),
      ...(verified.reason ? { reason: verified.reason } : {}),
      themes,
      claims,
      coverage,
      package: pkg.ref,
      draft: finalDraft,
      ...(verified.ref ? { verification: verified.ref } : {}),
      research,
    };
  }

  return restate.workflow({
    name: "ArticleRun",
    handlers: {
      run: async (ctx: restate.WorkflowContext, raw: ArticleRunInput): Promise<ArticleRunFinal> => {
        const parsed = ArticleRunInputSchema.safeParse(raw);
        if (!parsed.success) return { outcome: "failed", reason: "invalid-input", research: [] };
        try {
          const result = await runStages(ctx, parsed.data);
          logPipeline(parsed.data, "article-run", result.outcome, parsed.data.sourceVersion);
          return result;
        } catch (error) {
          // A permanent stage failure ends the run with its recorded reason.
          if (error instanceof restate.TerminalError) {
            logPipeline(parsed.data, "article-run", "failed", parsed.data.sourceVersion);
            return { outcome: "failed", reason: error.message.slice(0, 300), research: [] };
          }
          throw error;
        }
      },
    },
  });
}

/** A run's final result: a full result, or a failure before stage outputs existed. */
export type ArticleRunFinal =
  | ArticleRunResult
  | { outcome: "failed"; reason: string; research: [] };
export type ArticleRunApi = ReturnType<typeof articleRunWorkflow>;
