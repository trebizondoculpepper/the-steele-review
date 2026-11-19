import { createHash, randomUUID } from "node:crypto";
import { CloudEvent } from "cloudevents";
import { z } from "zod";
import type { Claim } from "../analysis/claim.js";
import type { ComparisonResult } from "../analysis/historical-comparison.js";
import type { GitArtifactStore } from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import type { ApplicabilityOutcome, ApplicabilityResult } from "../research/applicability.js";
import { saveDraftingBrief, type BriefInput, type SaveBriefOutcome } from "./brief.js";

/**
 * Research coordinator (#82): routes one analysed post from claims to a
 * saved drafting brief, asking the research keeper for what is needed.
 *
 * - The research keeper owns research decisions: it assesses each claim
 *   against the existing corpus (#38/#39). The coordinator only routes.
 * - A claim whose assessment leaves gaps becomes a research need. Needs are
 *   keyed by their content, so the same need from several posts or repeated
 *   runs is requested once (`research.requested`, handed off through the
 *   state controller).
 * - Nothing waits in memory: a post whose needs are outstanding records
 *   itself as a waiter and returns `waiting`. A `research.completed` event
 *   records the outcome once and re-advances every waiting post.
 * - Paused research (for example exhausted provider credit) pauses the post
 *   visibly; failed research leaves the claim as an evidence gap.
 * - When every need is settled, claims are re-assessed against the updated
 *   corpus and the brief is saved through #41, which hands off to drafting.
 *
 * No writing, verification or publication happens here, and all state
 * lives behind the state controller.
 */

export const RESEARCH_REQUESTED_SUBJECT = "steele.v1.research.requested";
export const RESEARCH_REQUESTED_EVENT_TYPE_V1 = "org.steele.research.requested.v1";

export const ResearchCompletedSchema = z
  .object({
    needId: z.string().regex(/^[0-9a-f]{64}$/),
    outcome: z.enum(["saved", "unresolved", "failed", "paused"]),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type ResearchCompleted = z.infer<typeof ResearchCompletedSchema>;

export interface CoordinatorPost {
  source: BriefInput["source"];
  claims: BriefInput["claims"];
  comparisons?: ComparisonResult[];
}

/** The research keeper: corpus search plus applicability assessment for one claim. */
export interface ResearchKeeper {
  assess(
    claim: Pick<Claim, "id" | "statement" | "passage">,
    signal?: AbortSignal,
  ): Promise<ApplicabilityOutcome>;
}

export type CoordinatorOutcome =
  | { kind: "brief"; result: SaveBriefOutcome }
  | { kind: "waiting"; needIds: string[] }
  | { kind: "paused"; needIds: string[] }
  | { kind: "retry"; reason: string };

export type CompletionOutcome =
  | { kind: "recorded"; advanced: Array<{ post: string; outcome: CoordinatorOutcome }> }
  | { kind: "duplicate" };

const postKey = (s: BriefInput["source"]) => `${s.publicationId}/${s.postId}@${s.sourceVersion}`;

/**
 * Content key of a research need: the normalised claim statement. Keying on
 * the claim (not its current gaps) means a claim is researched once per
 * settled result, so re-assessment after research can never loop.
 */
export function researchNeedId(statement: string): string {
  const norm = statement.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex");
}

export class ResearchCoordinator {
  constructor(
    private readonly config: {
      keeper: ResearchKeeper;
      operations: OperationStore;
      artifacts: Pick<GitArtifactStore, "write" | "lookup">;
      owner: string;
    },
  ) {}

  /** Move one post forward as far as current state allows. */
  async advance(post: CoordinatorPost, signal?: AbortSignal): Promise<CoordinatorOutcome> {
    const { operations } = this.config;
    const assessments: ApplicabilityResult[] = [];
    for (const claim of post.claims) {
      const a = await this.config.keeper.assess(claim, signal);
      if (a.status === "failed") return { kind: "retry", reason: `keeper:${a.reason}` };
      assessments.push(a);
    }

    const waiting: string[] = [];
    const paused: string[] = [];
    for (const [i, a] of assessments.entries()) {
      // The corpus already covers this claim.
      if (a.gaps.length === 0) continue;
      const needId = researchNeedId(post.claims[i]!.statement);
      // saved / unresolved / failed are settled; failed leaves an evidence gap.
      if (operations.operationStatus(`research-result:${needId}`)?.status === "completed") continue;
      if (operations.operationStatus(`research-paused:${needId}`)?.status === "completed") {
        paused.push(needId);
        continue;
      }
      this.request(needId, post.claims[i]!, a.gaps);
      this.wait(needId, post);
      waiting.push(needId);
    }
    if (paused.length) return { kind: "paused", needIds: paused };
    if (waiting.length) return { kind: "waiting", needIds: waiting };

    // Every need is settled: assessments above already read the updated corpus.
    const result = await saveDraftingBrief({
      brief: {
        source: post.source,
        claims: post.claims,
        assessments,
        ...(post.comparisons ? { comparisons: post.comparisons } : {}),
      },
      artifacts: this.config.artifacts,
      operations,
      owner: this.config.owner,
    });
    return { kind: "brief", result };
  }

  /**
   * Record a research outcome once, then re-advance every post waiting on
   * it. A repeated completion event is a no-op. A paused outcome can later
   * be superseded by a real result.
   */
  async onResearchCompleted(input: unknown, signal?: AbortSignal): Promise<CompletionOutcome> {
    const event = ResearchCompletedSchema.parse(input);
    const { operations } = this.config;
    const resultKey = `research-result:${event.needId}`;
    // A real result is final; repeats of it (or a late pause) change nothing.
    if (operations.operationStatus(resultKey)?.status === "completed") return { kind: "duplicate" };
    const artifact = { outcome: event.outcome, ...(event.reason ? { reason: event.reason } : {}) };
    if (event.outcome === "paused") {
      // Recorded separately so a later real result can supersede it.
      const pausedKey = `research-paused:${event.needId}`;
      if (operations.operationStatus(pausedKey)?.status === "completed")
        return { kind: "duplicate" };
      operations.reconcileCompleted(pausedKey, artifact, []);
      return { kind: "recorded", advanced: [] };
    }
    operations.reconcileCompleted(resultKey, artifact, []);

    const advanced: Array<{ post: string; outcome: CoordinatorOutcome }> = [];
    for (const waiter of operations.listOperations(`research-waiter:${event.needId}:`, 1_000)) {
      const post = waiter.artifact as CoordinatorPost | undefined;
      if (!post) continue;
      advanced.push({ post: postKey(post.source), outcome: await this.advance(post, signal) });
    }
    return { kind: "recorded", advanced };
  }

  /** Request research for a need once, however many posts or runs ask. */
  private request(needId: string, claim: Pick<Claim, "id" | "statement">, gaps: string[]): void {
    const claimed = this.config.operations.claim(
      `research-request:${needId}`,
      this.config.owner,
      60_000,
      5,
    );
    if (claimed.kind !== "claimed") return; // already requested (or in flight)
    const event = new CloudEvent({
      specversion: "1.0",
      id: randomUUID(),
      source: "urn:steele:drafting:coordinator",
      type: RESEARCH_REQUESTED_EVENT_TYPE_V1,
      time: new Date().toISOString(),
      subject: `research/${needId}`,
      datacontenttype: "application/json",
      data: { needId, question: claim.statement, claimId: claim.id, gaps },
    });
    this.config.operations.complete(claimed.claim, { needId }, [
      {
        eventId: event.id,
        subject: RESEARCH_REQUESTED_SUBJECT,
        payload: JSON.stringify(event.toJSON()),
      },
    ]);
  }

  /** Remember that a post waits on a need, so completion can resume it. */
  private wait(needId: string, post: CoordinatorPost): void {
    const key = `research-waiter:${needId}:${createHash("sha256").update(postKey(post.source)).digest("hex")}`;
    const claimed = this.config.operations.claim(key, this.config.owner, 60_000, 5);
    if (claimed.kind === "claimed") this.config.operations.complete(claimed.claim, post, []);
  }
}
