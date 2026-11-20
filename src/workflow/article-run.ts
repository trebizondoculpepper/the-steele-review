import * as restate from "@restatedev/restate-sdk";
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

export interface ArticleRunInput {
  publicationId: string;
  postId: string;
  sourceVersion: string;
  /** Public link to the original post (for the article). */
  sourceUrl: string;
  /** Batch deadline for research, from submission, in milliseconds. */
  researchDeadlineMs: number;
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
  verify(draft: Ref, pkg: Ref): Promise<{ ref?: Ref; approved: boolean; unavailable?: string }>;
}

/** A research job as pinned at the batch deadline. */
export type PinnedResearch =
  | { jobId: string; request: ResearchRequest; outcome: "finished"; job: CommissionedJob }
  | { jobId: string; request: ResearchRequest; outcome: "timed-out" | "failed" };

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

export function articleRunWorkflow(stages: ArticleStages) {
  // Only the shape is used for typed calls; handlers run in the Research service.
  const Research = researchService(stages);
  return restate.workflow({
    name: "ArticleRun",
    handlers: {
      run: async (
        ctx: restate.WorkflowContext,
        input: ArticleRunInput,
      ): Promise<ArticleRunResult> => {
        // The deadline clock starts at submission: journaled once, fixed on replay.
        const submittedAt = await ctx.date.now();
        const deadline = submittedAt + input.researchDeadlineMs;

        const themes = await ctx.run("themes", () => stages.themes(input));
        const claims = await ctx.run("claims", () => stages.claims(input, themes));
        const requests = await ctx.run("plan-research", () => stages.planResearch(themes, claims));

        // Fan out every request at once; the scope's concurrency rule queues extras.
        const pending = new Map<
          number,
          restate.RestatePromise<{ i: number; job?: CommissionedJob }>
        >();
        requests.forEach((request, i) => {
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
          const job = harvested.get(i);
          if (job) return { jobId, request, outcome: "finished", job };
          return { jobId, request, outcome: job === null ? "failed" : "timed-out" };
        });
        const research = pinned.map((p) => ({ jobId: p.jobId, outcome: p.outcome }));

        const coverage = await ctx.run("coverage", () => stages.coverage(themes, claims, pinned));
        const pkg = await ctx.run("package", () => stages.package(coverage));
        if (pkg.status !== "ready") {
          return { outcome: "evidence-gap", themes, claims, coverage, package: pkg.ref, research };
        }
        const drafted = await ctx.run("draft", () => stages.draft(pkg.ref, input.sourceUrl));
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
        const verified = await ctx.run("verify", () => stages.verify(drafted.ref!, pkg.ref));
        if (verified.unavailable) {
          return {
            outcome: "drafted-unverified",
            reason: verified.unavailable,
            themes,
            claims,
            coverage,
            package: pkg.ref,
            draft: drafted.ref,
            research,
          };
        }
        return {
          outcome: verified.approved ? "verified" : "rejected",
          themes,
          claims,
          coverage,
          package: pkg.ref,
          draft: drafted.ref,
          ...(verified.ref ? { verification: verified.ref } : {}),
          research,
        };
      },
    },
  });
}
export type ArticleRunApi = ReturnType<typeof articleRunWorkflow>;
