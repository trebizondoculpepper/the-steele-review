import { logPipeline } from "../observability/pipeline-log.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import { PackageVerificationReportSchema, approvalValidFor } from "../drafting/package-verify.js";
import {
  ARTICLE_APPROVED_SUBJECT,
  ArticleApprovedDataSchema,
  createArticleApprovedEvent,
  parseArticleApprovedEvent,
  type ArticleApprovedData,
} from "../events/article-approved-event.js";
import { writeOnce } from "../research/job.js";

/**
 * Multi-destination publishing contract (#262).
 *
 * 1. `recordApproval` turns an approved package verification (#150) into one
 *    durable approved-article event in the state controller's outbox, keyed
 *    by the exact draft revision. A restart between approval and delivery
 *    cannot lose it; recording twice is a no-op with the same event ID.
 * 2. Each configured destination runs `handleApprovedArticle` from its own
 *    durable consumer. It re-reads the approved draft and report from the
 *    artifact store, checks the approval matches those exact bytes, honours
 *    its own schedule, and keeps its own intent, status and receipt keyed by
 *    article revision, destination and action. Duplicate delivery reuses the
 *    saved receipt; an uncertain delivery is reconciled before any retry; one
 *    destination failing never repeats another's delivery.
 *
 * Approval makes an article eligible for a destination's configured action.
 * Public delivery needs separate authorization and is outside this contract;
 * live adapters (for example Substack, #256) are follow-ups.
 */

const toRef = (r: ArtifactRef) => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  hash: `sha256:${r.sha256}`,
});
const fromRef = (r: {
  repository: string;
  commit: string;
  path: string;
  hash: string;
}): ArtifactRef => ({
  repository: r.repository,
  commit: r.commit,
  path: r.path,
  sha256: r.hash.replace(/^sha256:/, ""),
});

export class ApprovalError extends Error {
  constructor(reason: string) {
    super(`approval rejected: ${reason}`);
    this.name = "ApprovalError";
  }
}

/** Stable event ID for one approved draft revision and its approval. */
export const approvedArticleEventId = (draft: ArtifactRef, approval: ArtifactRef) =>
  `approved-${createHash("sha256")
    .update(JSON.stringify([toRef(draft), toRef(approval)]))
    .digest("hex")
    .slice(0, 32)}`;

/** Record one approved-article event in the outbox for an approved verification report. */
export async function recordApproval(input: {
  content: GitArtifactStore;
  operations: OperationStore;
  /** The saved package verification report (#150). */
  report: ArtifactRef;
  now?: () => Date;
}): Promise<{ eventId: string; data: ArticleApprovedData }> {
  const report = PackageVerificationReportSchema.parse(
    JSON.parse(await input.content.read(input.report)),
  );
  if (report.outcome !== "approved") throw new ApprovalError("report does not approve the draft");
  const draft = fromRef(report.draft);
  const markdown = await input.content.read(draft); // hash-verified read
  if (!approvalValidFor(report, markdown))
    throw new ApprovalError("approval does not match the draft");
  const pkg = JSON.parse(await input.content.read(fromRef(report.package))) as {
    post: { publicationId: string; postId: string };
  };
  const eventId = approvedArticleEventId(draft, input.report);
  const data: ArticleApprovedData = {
    publicationId: pkg.post.publicationId,
    postId: pkg.post.postId,
    draft: report.draft,
    approval: toRef(input.report),
    package: report.package,
    approvedAt: report.verifiedAt,
  };
  const event = createArticleApprovedEvent(data, eventId);
  input.operations.reconcileCompleted(`approved:${eventId}`, { eventId }, [
    { eventId, subject: ARTICLE_APPROVED_SUBJECT, payload: JSON.stringify(event.toJSON()) },
  ]);
  return { eventId, data };
}

// ---------------------------------------------------------------------------
// Destinations

/** What a destination adapter produces for an approved article. */
export interface DestinationPreview {
  /** Rendered content in the destination's own format. */
  body: string;
  contentType: string;
}

export const DeliveryReceiptSchema = z
  .object({
    destination: z.string(),
    action: z.string(),
    /** True for placeholder deliveries that made no external call. */
    simulated: z.boolean(),
    draftHash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    externalId: z.string().optional(),
    url: z.string().optional(),
    deliveredAt: z.string(),
  })
  .strict();
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

/** A delivery whose outcome is unknown (for example a timeout after sending). */
export class UncertainDeliveryError extends Error {
  constructor() {
    super("delivery outcome is uncertain");
    this.name = "UncertainDeliveryError";
  }
}

/**
 * The destination cannot be used right now (expired session, rate limit or
 * outage) and nothing was sent. The delivery waits without spending its
 * attempt budget, so an expired session never exhausts an approval.
 */
export class DestinationUnavailableError extends Error {
  constructor(
    readonly reason: "auth-expired" | "rate-limited" | "unavailable",
    readonly retryAfterMs: number,
  ) {
    super(`destination unavailable: ${reason}`);
    this.name = "DestinationUnavailableError";
  }
}

/** What `reconcile` knows about the uncertain attempt it is resolving. */
export interface ReconcileContext {
  preview: DestinationPreview;
  /** When intent was recorded, before the attempt; absent for older attempts. */
  intentAt?: string;
}

/**
 * One destination. It owns rendering and its capabilities; `deliver` must be
 * idempotent for the given key, and `reconcile` reports whether an earlier
 * uncertain delivery for that key actually happened.
 */
export interface DestinationAdapter {
  readonly name: string;
  readonly action: string;
  render(article: { markdown: string; data: ArticleApprovedData }): DestinationPreview;
  deliver(
    preview: DestinationPreview,
    key: string,
  ): Promise<Omit<DeliveryReceipt, "destination" | "action">>;
  reconcile(
    key: string,
    context?: ReconcileContext,
  ): Promise<
    | { delivered: Omit<DeliveryReceipt, "destination" | "action"> }
    | { delivered: false }
    | "unknown"
  >;
}

export interface DestinationSchedule {
  /** Earliest delivery, as a delay after approval. */
  delayMs: number;
}

export type DeliveryDecision =
  | { action: "ack"; outcome: "delivered" | "reused"; receipt: ArtifactRef }
  | {
      action: "nak";
      delayMs: number;
      reason:
        | "scheduled"
        | "busy"
        | "retry"
        | "uncertain"
        | "auth-expired"
        | "rate-limited"
        | "unavailable";
    }
  | { action: "term"; reason: "invalid-event" | "approval-mismatch" | "exhausted" };

function deliveryDirectory(
  article: Pick<ArticleApprovedData, "publicationId" | "postId" | "draft">,
  destination: Pick<DestinationAdapter, "name" | "action">,
): string {
  const revision = article.draft.hash.replace(/^sha256:/, "").slice(0, 32);
  return `publications/${destination.name}/${destination.action}/${article.publicationId}/${article.postId}/${revision}`;
}

/** Read durable proof for both dummy destinations for one exact approved revision. */
export async function readDummyDeliveryProof(
  content: Pick<GitArtifactStore, "lookup" | "read">,
  article: ArticleApprovedData,
): Promise<{ a: ArtifactRef; b: ArtifactRef } | undefined> {
  const approved = ArticleApprovedDataSchema.parse(article);
  const read = async (name: string) => {
    const dir = deliveryDirectory(approved, { name, action: "draft" });
    const ref = await content.lookup(`${dir}/receipt.json`);
    if (!ref) return undefined;
    const receipt = DeliveryReceiptSchema.parse(JSON.parse(await content.read(ref)));
    if (
      !receipt.simulated ||
      receipt.destination !== name ||
      receipt.action !== "draft" ||
      receipt.draftHash !== approved.draft.hash
    ) {
      throw new ApprovalError("dummy receipt does not prove the approved draft");
    }
    return ref;
  };
  const [a, b] = await Promise.all([read("dummy-a"), read("dummy-b")]);
  return a && b ? { a, b } : undefined;
}

/** Handle one approved-article delivery for one destination. */
export async function handleApprovedArticle(input: {
  payload: string;
  destination: DestinationAdapter;
  schedule: DestinationSchedule;
  content: GitArtifactStore;
  operations: OperationStore;
  owner: string;
  now?: () => Date;
  retryDelayMs?: number;
}): Promise<DeliveryDecision> {
  const now = (input.now ?? (() => new Date()))();
  let event;
  try {
    event = parseArticleApprovedEvent(input.payload);
  } catch {
    return { action: "term", reason: "invalid-event" };
  }
  const decision = await deliverApprovedArticle(input, event, now);
  logPipeline(
    event,
    "publisher",
    decision.action === "ack" ? decision.outcome : decision.reason,
    undefined,
    input.destination.name,
  );
  return decision;
}

async function deliverApprovedArticle(
  input: Parameters<typeof handleApprovedArticle>[0],
  event: ReturnType<typeof parseArticleApprovedEvent>,
  now: Date,
): Promise<DeliveryDecision> {
  // Independent schedule per destination.
  const due = Date.parse(event.approvedAt) + input.schedule.delayMs;
  if (now.getTime() < due)
    return { action: "nak", delayMs: due - now.getTime(), reason: "scheduled" };

  // Re-check the approval against the exact stored bytes.
  let markdown: string;
  try {
    markdown = await input.content.read(fromRef(event.draft));
    const report = PackageVerificationReportSchema.parse(
      JSON.parse(await input.content.read(fromRef(event.approval))),
    );
    if (!approvalValidFor(report, markdown) || report.draft.hash !== event.draft.hash) {
      return { action: "term", reason: "approval-mismatch" };
    }
  } catch (error) {
    // Only a confirmed mismatch or missing artifact is final; anything else is transient.
    if (
      error instanceof ArtifactStoreError &&
      (error.code === "hash-mismatch" || error.code === "not-found")
    ) {
      return { action: "term", reason: "approval-mismatch" };
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return { action: "term", reason: "approval-mismatch" };
    }
    return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "retry" };
  }

  const { destination } = input;
  const revision = event.draft.hash.replace(/^sha256:/, "").slice(0, 32);
  const key = `publish:${destination.name}:${destination.action}:${revision}`;
  const dir = deliveryDirectory(event, destination);
  // A receipt committed before a crash is the durable result: record completion
  // from it rather than delivering again or giving up on attempt limits.
  const committed = await input.content.lookup(`${dir}/receipt.json`);
  if (committed) {
    input.operations.reconcileCompleted(
      key,
      { path: committed.path, commit: committed.commit },
      [],
    );
    return { action: "ack", outcome: "reused", receipt: committed };
  }
  const claim = input.operations.claim(key, input.owner, 10 * 60_000, 5);
  if (claim.kind === "completed") {
    const saved = await input.content.lookup(`${dir}/receipt.json`);
    if (saved) return { action: "ack", outcome: "reused", receipt: saved };
  }
  if (claim.kind === "busy") return { action: "nak", delayMs: 5_000, reason: "busy" };
  if (claim.kind === "exhausted") return { action: "term", reason: "exhausted" };
  if (claim.kind !== "claimed")
    return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "retry" };

  // The preview (including any pinned byline, #459) is durable before the
  // external attempt. A retry must reuse the stored one: re-rendering after a
  // configuration change could otherwise alter or lose the pinned attribution.
  const storedPreview = await input.content.lookup(`${dir}/preview.json`);
  let preview: DestinationPreview;
  if (storedPreview) {
    try {
      preview = JSON.parse(await input.content.read(storedPreview)) as DestinationPreview;
    } catch (error) {
      // A repository read failure is operational: retry rather than abandon an
      // approval that may still reconcile to an existing draft.
      if (error instanceof ArtifactStoreError && error.code === "git-failed") {
        input.operations.yieldClaim(claim.claim);
        return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "retry" };
      }
      input.operations.fail(claim.claim, "invalid-preview", false);
      return { action: "term", reason: "approval-mismatch" };
    }
  } else {
    preview = destination.render({ markdown, data: event });
    await writeOnce(input.content, `${dir}/preview.json`, preview);
  }
  try {
    let delivered: Omit<DeliveryReceipt, "destination" | "action"> | undefined;
    // An earlier uncertain attempt must be reconciled before any retry.
    // The uncertain marker is a durable, write-once artifact beside the receipt.
    // Intent, with its time, is durable before any external attempt, so
    // reconciliation can tell whether a listing covers the attempt.
    const intentRef = await input.content.lookup(`${dir}/intent.json`);
    const intentAt = intentRef
      ? (JSON.parse(await input.content.read(intentRef)) as { at?: string }).at
      : (await writeOnce(input.content, `${dir}/intent.json`, { key, at: now.toISOString() }),
        now.toISOString());
    // An intent left by an earlier attempt that produced no receipt is
    // unresolved too: the process may have stopped after the destination acted
    // but before the receipt was committed. Reconcile before any new attempt.
    if (intentRef || (await input.content.lookup(`${dir}/uncertain.json`))) {
      const r = await destination.reconcile(key, { preview, ...(intentAt ? { intentAt } : {}) });
      if (r === "unknown") {
        input.operations.fail(claim.claim, "uncertain-delivery", true);
        return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "uncertain" };
      }
      if (r.delivered) delivered = r.delivered;
    }
    delivered ??= await destination.deliver(preview, key);
    const receipt = DeliveryReceiptSchema.parse({
      destination: destination.name,
      action: destination.action,
      ...delivered,
      draftHash: event.draft.hash,
    });
    const ref = await writeOnce(input.content, `${dir}/receipt.json`, receipt);
    input.operations.complete(claim.claim, { path: ref.path, commit: ref.commit }, []);
    return { action: "ack", outcome: "delivered", receipt: ref };
  } catch (error) {
    if (error instanceof DestinationUnavailableError) {
      // Nothing was sent: wait without spending the attempt budget.
      input.operations.yieldClaim(claim.claim);
      return { action: "nak", delayMs: error.retryAfterMs, reason: error.reason };
    }
    if (error instanceof UncertainDeliveryError) {
      await writeOnce(input.content, `${dir}/uncertain.json`, {
        key,
        recordedAt: now.toISOString(),
      });
      input.operations.fail(claim.claim, "uncertain-delivery", true);
      return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "uncertain" };
    }
    input.operations.fail(claim.claim, "delivery-failed", true);
    return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "retry" };
  }
}

/**
 * Placeholder destination for the end-to-end proof: renders the article and
 * writes a receipt explicitly marked simulated. No external calls, no
 * credentials. `failTimes` makes it fail its first deliveries, for tests.
 */
export class SimulatedDestination implements DestinationAdapter {
  readonly deliveries: string[] = [];
  private failures: number;
  constructor(
    readonly name: string,
    readonly action: string,
    options: { failTimes?: number; uncertainTimes?: number } = {},
    private uncertain = options.uncertainTimes ?? 0,
  ) {
    this.failures = options.failTimes ?? 0;
  }
  render({ markdown, data }: { markdown: string; data: ArticleApprovedData }): DestinationPreview {
    return {
      body: `<!-- ${this.name} preview for ${data.publicationId}/${data.postId} -->\n${markdown}`,
      contentType: "text/markdown",
    };
  }
  async deliver(_preview: DestinationPreview, key: string) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("simulated failure");
    }
    if (this.uncertain > 0) {
      this.uncertain--;
      this.deliveries.push(key); // it did happen, but the caller can't tell
      throw new UncertainDeliveryError();
    }
    this.deliveries.push(key);
    return {
      simulated: true,
      externalId: `sim-${this.deliveries.length}`,
      deliveredAt: new Date(0).toISOString(),
    };
  }
  async reconcile(key: string) {
    return this.deliveries.includes(key)
      ? {
          delivered: {
            simulated: true,
            externalId: `sim-reconciled`,
            deliveredAt: new Date(0).toISOString(),
          },
        }
      : { delivered: false as const };
  }
}
