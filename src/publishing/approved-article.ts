import { ArtifactReferenceSchema } from "../content/artifact-reference.js";
import { logPipeline } from "../observability/pipeline-log.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ArtifactStoreError,
  type ArtifactRef,
  type GitArtifactStore,
} from "../controllers/artifact-store.js";
import type { OperationStore } from "../controllers/operation-store.js";
import {
  readPublicationPayload,
  sameArtifact,
  PublicationPayloadError,
  PublicationPayloadSchema,
  publicationManifestHash,
  type PublicationPayload,
} from "../drafting/publication-payload.js";
import {
  readApprovalEvidence,
  ApprovalEvidenceError,
  type ApprovalKind,
  type ApprovalEvidence,
} from "./approval-evidence.js";
import { DraftTargetSchema, type DraftTarget } from "../content/owner-draft-authorization.js";
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
  kind?: ApprovalKind;
  now?: () => Date;
}): Promise<{ eventId: string; data: ArticleApprovedData }> {
  const evidence = await readApprovalEvidence(
    input.content,
    input.report,
    input.kind,
    input.operations,
  );
  const { eventId, data, event } = approvalEventFor(evidence, input.report);
  input.operations.reconcileCompleted(`approved:${eventId}`, { eventId }, [
    { eventId, subject: ARTICLE_APPROVED_SUBJECT, payload: JSON.stringify(event.toJSON()) },
  ]);
  return { eventId, data };
}

/** Shared pure envelope construction; authorization is checked by the caller. */
export function approvalEventFor(evidence: ApprovalEvidence, report: ArtifactRef) {
  const eventId = approvedArticleEventId(fromRef(evidence.body), report);
  const data: ArticleApprovedData = {
    publicationId: evidence.post.publicationId,
    postId: evidence.post.postId,
    draft: evidence.body,
    approval: toRef(report),
    ...(evidence.publication ? { publication: evidence.publication } : {}),
    ...(evidence.kind !== "combined-verification"
      ? { approvalKind: evidence.kind, assessment: evidence.assessment }
      : {}),
    ...(evidence.authorizationOutcome
      ? { authorizationOutcome: evidence.authorizationOutcome, draftTargets: evidence.draftTargets }
      : {}),
    package: evidence.package,
    approvedAt: evidence.approvedAt,
  };
  const event = createArticleApprovedEvent(data, eventId);
  return { eventId, data, event };
}

// ---------------------------------------------------------------------------
// Destinations

/** What a destination adapter produces for an approved article. */
export interface DestinationPreview {
  /** Rendered content in the destination's own format. */
  body: string;
  contentType: string;
  /** Exact saved payload, retained by simulated previews; live adapters map approved fields explicitly. */
  publication?: PublicationPayload;
  draftAuthorization?: DraftTarget;
}

export const DeliveryReceiptSchema = z
  .object({
    destination: z.string(),
    action: z.string(),
    /** True for placeholder deliveries that made no external call. */
    simulated: z.boolean(),
    publicationHash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    /** Manifest actually used for this delivery; retained unchanged on identical-content reuse. */
    publication: ArtifactReferenceSchema.optional(),
    approvalKind: z
      .enum(["combined-verification", "editorial-judgment", "owner-draft-rehearsal"])
      .optional(),
    authorizationOutcome: z.literal("owner-authorized-draft").optional(),
    draftTarget: DraftTargetSchema.optional(),
    draftSafety: z
      .object({ unpublished: z.literal(true), emailTimestampAbsent: z.literal(true) })
      .strict()
      .optional(),
    approval: ArtifactReferenceSchema.optional(),
    assessment: ArtifactReferenceSchema.optional(),
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
    readonly reason: "auth-expired" | "rate-limited" | "unavailable" | "paused",
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
  /** Absent by default. Only a narrowly implemented draft-only adapter opts in. */
  readonly draftTarget?: DraftTarget;
  /** Opt in only when render consumes the exact structured fields without substitutions. */
  readonly supportsPublicationPayload?: boolean;
  render(article: {
    markdown: string;
    data: ArticleApprovedData;
    publication?: PublicationPayload;
  }): DestinationPreview;
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

/** Fresh configuration-handler decision; no configuration is copied or cached here.
 * The handler must check current stop/action policy AND the target's current
 * identity/capability, so a stale adapter cannot approve its own old snapshot.
 */
export interface DraftDeliveryControl {
  allow(target: DraftTarget): Promise<boolean>;
}

export type DeliveryDecision =
  | { action: "ack"; outcome: "delivered" | "reused"; receipt: ArtifactRef }
  | {
      action: "nak";
      delayMs: number;
      reason:
        | "unsupported-payload"
        | "paused"
        | "scheduled"
        | "busy"
        | "retry"
        | "uncertain"
        | "auth-expired"
        | "rate-limited"
        | "unavailable";
    }
  | { action: "term"; reason: "invalid-event" | "approval-mismatch" | "exhausted" };

const DeliveryIntentSchema = z.looseObject({
  key: z.string().min(1),
  at: z.iso.datetime({ offset: true }).optional(),
  /** The original approved version, retained even if equal content is approved again. */
  article: ArticleApprovedDataSchema.optional(),
});
const SavedPreviewSchema = z.looseObject({
  body: z.string().max(2_000_000),
  contentType: z.string().min(1).max(200),
  publication: PublicationPayloadSchema.optional(),
  draftAuthorization: DraftTargetSchema.optional(),
});

export async function readApprovedContent(
  content: Pick<GitArtifactStore, "read">,
  article: ArticleApprovedData,
  operations?: Pick<OperationStore, "ownerDraftAuthorization" | "editorialRecoveryAttempt">,
) {
  const evidence = await readApprovalEvidence(
    content,
    fromRef(article.approval),
    article.approvalKind,
    operations,
  );
  if (
    evidence.authorizationOutcome !== article.authorizationOutcome ||
    JSON.stringify(evidence.draftTargets) !== JSON.stringify(article.draftTargets) ||
    evidence.post.publicationId !== article.publicationId ||
    evidence.post.postId !== article.postId ||
    !sameArtifact(evidence.body, article.draft) ||
    !sameArtifact(evidence.package, article.package) ||
    (evidence.publication
      ? !article.publication || !sameArtifact(evidence.publication, article.publication)
      : article.publication !== undefined) ||
    (evidence.assessment
      ? !article.assessment || !sameArtifact(evidence.assessment, article.assessment)
      : article.assessment !== undefined)
  )
    throw new ApprovalError("approval does not match the draft");
  return { markdown: evidence.markdown, publication: evidence.payload };
}

/** Checked before receipt reuse, original-intent replay, reconciliation and creation. */
export function assertDraftAuthorizationTarget(
  article: ArticleApprovedData,
  destination: Pick<DestinationAdapter, "name" | "action" | "draftTarget">,
): DraftTarget | undefined {
  if (article.approvalKind !== "owner-draft-rehearsal") return undefined;
  const actual = DraftTargetSchema.safeParse(destination.draftTarget);
  if (
    !actual.success ||
    destination.action !== "draft" ||
    actual.data.name !== destination.name ||
    !article.draftTargets?.some((t) => JSON.stringify(t) === JSON.stringify(actual.data))
  )
    throw new ApprovalError("draft authorization target mismatch");
  return actual.data;
}

export function dummyDraftTarget(name: string): DraftTarget | undefined {
  return ["dummy-a", "dummy-b"].includes(name)
    ? {
        name,
        provider: "dummy",
        action: "draft",
        capability: "unpublished-no-email-v1",
        identity: `sha256:${createHash("sha256")
          .update(JSON.stringify(["dummy-draft-v1", name]))
          .digest("hex")}`,
      }
    : undefined;
}

function ownerReceiptMatches(
  receipt: DeliveryReceipt,
  article: ArticleApprovedData,
  destination: Pick<DestinationAdapter, "name" | "action" | "draftTarget">,
): boolean {
  if (article.approvalKind !== "owner-draft-rehearsal") return true;
  const target = assertDraftAuthorizationTarget(article, destination);
  return (
    receipt.destination === destination.name &&
    receipt.action === destination.action &&
    receipt.approvalKind === "owner-draft-rehearsal" &&
    receipt.authorizationOutcome === "owner-authorized-draft" &&
    !!receipt.approval &&
    sameArtifact(receipt.approval, article.approval) &&
    !!receipt.assessment &&
    !!article.assessment &&
    sameArtifact(receipt.assessment, article.assessment) &&
    !!receipt.publication &&
    !!article.publication &&
    sameArtifact(receipt.publication, article.publication) &&
    JSON.stringify(receipt.draftTarget) === JSON.stringify(target) &&
    (target?.provider !== "substack" ||
      (receipt.simulated === false &&
        receipt.draftSafety?.unpublished === true &&
        receipt.draftSafety.emailTimestampAbsent === true))
  );
}

function deliveryDirectory(
  article: Pick<ArticleApprovedData, "publicationId" | "postId" | "draft" | "publication">,
  destination: Pick<DestinationAdapter, "name" | "action">,
  contentHash = article.draft.hash,
): string {
  const revision = contentHash.replace(/^sha256:/, "").slice(0, 32);
  return `publications/${destination.name}/${destination.action}/${article.publicationId}/${article.postId}/${revision}`;
}

/** Read durable proof for both dummy destinations for one exact approved revision. */
export async function readDummyDeliveryProof(
  content: Pick<GitArtifactStore, "lookup" | "read">,
  article: ArticleApprovedData,
  operations?: Pick<OperationStore, "ownerDraftAuthorization" | "editorialRecoveryAttempt">,
): Promise<{ a: ArtifactRef; b: ArtifactRef } | undefined> {
  const approved = ArticleApprovedDataSchema.parse(article);
  if (approved.approvalKind === "owner-draft-rehearsal")
    await readApprovedContent(content, approved, operations);
  const payload = approved.publication
    ? (await readPublicationPayload(content, approved.publication)).payload
    : undefined;
  if (payload && !sameArtifact(payload.body, approved.draft))
    throw new ApprovalError("dummy receipt does not prove the approved draft");
  const publicationHash = payload?.mode === "structured" ? payload.contentHash : undefined;
  const read = async (name: string) => {
    const dir = deliveryDirectory(
      approved,
      { name, action: "draft" },
      publicationHash ?? approved.draft.hash,
    );
    const ref = await content.lookup(`${dir}/receipt.json`);
    if (!ref) return undefined;
    const receipt = DeliveryReceiptSchema.parse(JSON.parse(await content.read(ref)));
    if (
      !receipt.simulated ||
      receipt.destination !== name ||
      receipt.action !== "draft" ||
      receipt.draftHash !== approved.draft.hash ||
      receipt.publicationHash !== publicationHash ||
      !ownerReceiptMatches(receipt, approved, {
        name,
        action: "draft",
        draftTarget: dummyDraftTarget(name),
      })
    ) {
      throw new ApprovalError("dummy receipt does not prove the approved draft");
    }
    return ref;
  };
  const [a, b] = await Promise.all([read("dummy-a"), read("dummy-b")]);
  return a && b ? { a, b } : undefined;
}

/** Read the exact destination receipt for acknowledgement/reconnect recovery. */
export async function readDestinationDeliveryProof(
  content: Pick<GitArtifactStore, "lookup" | "read">,
  article: ArticleApprovedData,
  destination: Pick<DestinationAdapter, "name" | "action" | "draftTarget">,
  expectedSimulated?: boolean,
  operations?: Pick<OperationStore, "ownerDraftAuthorization" | "editorialRecoveryAttempt">,
): Promise<ArtifactRef | undefined> {
  const approved = ArticleApprovedDataSchema.parse(article);
  const checked = await readApprovedContent(content, approved, operations);
  assertDraftAuthorizationTarget(approved, destination);
  const publicationHash =
    checked.publication?.mode === "structured" ? checked.publication.contentHash : undefined;
  const ref = await content.lookup(
    `${deliveryDirectory(approved, destination, publicationHash ?? approved.draft.hash)}/receipt.json`,
  );
  if (!ref) return undefined;
  const receipt = DeliveryReceiptSchema.parse(JSON.parse(await content.read(ref)));
  if (
    receipt.destination !== destination.name ||
    receipt.action !== destination.action ||
    (expectedSimulated !== undefined && receipt.simulated !== expectedSimulated) ||
    receipt.draftHash !== approved.draft.hash ||
    receipt.publicationHash !== publicationHash ||
    (publicationHash !== undefined && !receipt.publication) ||
    !ownerReceiptMatches(receipt, approved, destination)
  )
    throw new ApprovalError("receipt does not prove the selected publication");
  return ref;
}

/** Handle one approved-article delivery for one destination. */
export async function handleApprovedArticle(input: {
  payload: string;
  destination: DestinationAdapter;
  schedule: DestinationSchedule;
  content: GitArtifactStore;
  operations: OperationStore;
  deliveryControl?: DraftDeliveryControl;
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
  let publication: PublicationPayload | undefined;
  try {
    const checked = await readApprovedContent(input.content, event, input.operations);
    const target = assertDraftAuthorizationTarget(event, input.destination);
    if (target && !(await input.deliveryControl?.allow(target)))
      return { action: "nak", reason: "paused", delayMs: input.retryDelayMs ?? 30_000 };
    markdown = checked.markdown;
    publication = checked.publication;
  } catch (error) {
    // Only a confirmed mismatch or missing artifact is final; anything else is transient.
    if (
      error instanceof ArtifactStoreError &&
      (error.code === "hash-mismatch" || error.code === "not-found")
    ) {
      return { action: "term", reason: "approval-mismatch" };
    }
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof PublicationPayloadError ||
      error instanceof ApprovalError ||
      error instanceof ApprovalEvidenceError
    ) {
      return { action: "term", reason: "approval-mismatch" };
    }
    return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "retry" };
  }

  const { destination } = input;
  const publicationHash = publication?.mode === "structured" ? publication.contentHash : undefined;
  const revision = (publicationHash ?? event.draft.hash).replace(/^sha256:/, "").slice(0, 32);
  const key = `publish:${destination.name}:${destination.action}:${revision}`;
  const dir = deliveryDirectory(event, destination, publicationHash ?? event.draft.hash);
  // A receipt committed before a crash is the durable result: record completion
  // from it rather than delivering again or giving up on attempt limits.
  const committed = await input.content.lookup(`${dir}/receipt.json`);
  if (committed) {
    const receipt = DeliveryReceiptSchema.parse(JSON.parse(await input.content.read(committed)));
    if (
      receipt.publicationHash !== publicationHash ||
      receipt.draftHash !== event.draft.hash ||
      (publicationHash !== undefined && receipt.publication === undefined) ||
      !ownerReceiptMatches(receipt, event, destination)
    )
      return { action: "term", reason: "approval-mismatch" };
    input.operations.reconcileCompleted(
      key,
      { path: committed.path, commit: committed.commit },
      [],
    );
    return { action: "ack", outcome: "reused", receipt: committed };
  }
  if (publication?.mode === "structured" && destination.supportsPublicationPayload !== true)
    return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "unsupported-payload" };
  const claim = input.operations.claim(key, input.owner, 10 * 60_000, 5);
  if (claim.kind === "completed") {
    const saved = await input.content.lookup(`${dir}/receipt.json`);
    if (saved) {
      if (event.approvalKind === "owner-draft-rehearsal") {
        const receipt = DeliveryReceiptSchema.parse(JSON.parse(await input.content.read(saved)));
        if (!ownerReceiptMatches(receipt, event, destination))
          return { action: "term", reason: "approval-mismatch" };
      }
      return { action: "ack", outcome: "reused", receipt: saved };
    }
  }
  if (claim.kind === "busy") return { action: "nak", delayMs: 5_000, reason: "busy" };
  if (claim.kind === "exhausted") return { action: "term", reason: "exhausted" };
  if (claim.kind !== "claimed")
    return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "retry" };

  try {
    const requireLive = async (article: ArticleApprovedData) => {
      const target = assertDraftAuthorizationTarget(article, destination);
      if (!target) return;
      let allowed: boolean | undefined;
      try {
        allowed = await input.deliveryControl?.allow(target);
      } catch {
        throw new DestinationUnavailableError("unavailable", input.retryDelayMs ?? 30_000);
      }
      if (!allowed) throw new DestinationUnavailableError("paused", input.retryDelayMs ?? 30_000);
    };
    const holdUncertain = (): DeliveryDecision => {
      input.operations.yieldClaim(claim.claim);
      return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "uncertain" };
    };
    const priorIntent = await input.content.lookup(`${dir}/intent.json`);
    const priorPreview = await input.content.lookup(`${dir}/preview.json`);
    const uncertain = await input.content.lookup(`${dir}/uncertain.json`);
    // An orphaned uncertain attempt has no authoritative original version.
    if (!priorIntent && (uncertain || (publication?.mode === "structured" && priorPreview)))
      return holdUncertain();
    const currentArticle: ArticleApprovedData = {
      publicationId: event.publicationId,
      postId: event.postId,
      draft: event.draft,
      approval: event.approval,
      ...(event.approvalKind ? { approvalKind: event.approvalKind } : {}),
      ...(event.authorizationOutcome
        ? { authorizationOutcome: event.authorizationOutcome, draftTargets: event.draftTargets }
        : {}),
      ...(event.assessment ? { assessment: event.assessment } : {}),
      package: event.package,
      approvedAt: event.approvedAt,
      ...(event.publication ? { publication: event.publication } : {}),
    };
    const candidate = `${JSON.stringify({ key, at: now.toISOString(), article: currentArticle }, null, 2)}\n`;
    // Intent precedes preview and any external action. Re-read the retained
    // write-once result rather than assuming this caller won the write.
    const intentRef =
      priorIntent ?? (await writeOnce(input.content, `${dir}/intent.json`, candidate));
    const rawIntent = await input.content.read(intentRef);
    const parsedIntent = DeliveryIntentSchema.safeParse(JSON.parse(rawIntent));
    if (!parsedIntent.success || parsedIntent.data.key !== key) return holdUncertain();
    const intent = parsedIntent.data;
    let deliveryArticle = currentArticle;
    let deliveryMarkdown = markdown;
    let deliveryPublication = publication;
    if (intent.article) {
      const original = await readApprovedContent(input.content, intent.article, input.operations);
      assertDraftAuthorizationTarget(intent.article, destination);
      if (
        event.approvalKind === "owner-draft-rehearsal" &&
        (!sameArtifact(intent.article.approval, event.approval) ||
          intent.article.approvalKind !== event.approvalKind)
      )
        return holdUncertain();
      const originalHash =
        original.publication?.mode === "structured"
          ? original.publication.contentHash
          : intent.article.draft.hash;
      if (
        originalHash !== (publicationHash ?? event.draft.hash) ||
        intent.article.publicationId !== event.publicationId ||
        intent.article.postId !== event.postId
      )
        return holdUncertain();
      deliveryArticle = intent.article;
      deliveryMarkdown = original.markdown;
      deliveryPublication = original.publication;
    } else {
      // Old intent records know only body identity. Never invent a manifest
      // for a structured side effect whose original provenance is unknown.
      if (publication?.mode === "structured") return holdUncertain();
      deliveryArticle = {
        publicationId: event.publicationId,
        postId: event.postId,
        draft: event.draft,
        approval: event.approval,
        package: event.package,
        approvedAt: event.approvedAt,
      };
      deliveryPublication = undefined;
    }
    const previewRef =
      priorPreview ??
      (await writeOnce(
        input.content,
        `${dir}/preview.json`,
        destination.render({
          markdown: deliveryMarkdown,
          data: deliveryArticle,
          ...(deliveryPublication ? { publication: deliveryPublication } : {}),
        }),
      ));
    const preview = SavedPreviewSchema.parse(JSON.parse(await input.content.read(previewRef)));
    if (
      deliveryArticle.approvalKind === "owner-draft-rehearsal" &&
      JSON.stringify(preview.draftAuthorization) !==
        JSON.stringify(assertDraftAuthorizationTarget(deliveryArticle, destination))
    )
      return holdUncertain();
    if (
      preview.publication &&
      (!deliveryArticle.publication ||
        publicationManifestHash(preview.publication) !== deliveryArticle.publication.hash)
    )
      return holdUncertain();
    let delivered: Omit<DeliveryReceipt, "destination" | "action"> | undefined;
    // A previous or concurrently retained intent may have acted already. Its
    // original preview and timestamp, not the newer event's, drive reconciliation.
    if (priorIntent || rawIntent !== candidate || uncertain) {
      await requireLive(deliveryArticle);
      const r = await destination.reconcile(key, {
        preview,
        ...(intent.at ? { intentAt: intent.at } : {}),
      });
      if (r === "unknown") {
        input.operations.fail(claim.claim, "uncertain-delivery", true);
        return { action: "nak", delayMs: input.retryDelayMs ?? 30_000, reason: "uncertain" };
      }
      if (r.delivered) delivered = r.delivered;
    }
    if (!delivered) {
      await requireLive(deliveryArticle);
      input.operations.renew(claim.claim, 10 * 60_000);
      delivered = await destination.deliver(preview, key);
    }
    const receipt = DeliveryReceiptSchema.parse({
      destination: destination.name,
      action: destination.action,
      ...delivered,
      ...(deliveryArticle.approvalKind && deliveryArticle.approvalKind !== "combined-verification"
        ? {
            approvalKind: deliveryArticle.approvalKind,
            approval: deliveryArticle.approval,
            assessment: deliveryArticle.assessment,
          }
        : {}),
      ...(deliveryArticle.authorizationOutcome
        ? {
            authorizationOutcome: deliveryArticle.authorizationOutcome,
            draftTarget: assertDraftAuthorizationTarget(deliveryArticle, destination),
          }
        : {}),
      draftHash: deliveryArticle.draft.hash,
      ...(publicationHash ? { publicationHash } : {}),
      ...(deliveryArticle.publication ? { publication: deliveryArticle.publication } : {}),
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
  readonly supportsPublicationPayload = true;
  readonly deliveries: string[] = [];
  private failures: number;
  get draftTarget(): DraftTarget | undefined {
    return this.action === "draft" ? dummyDraftTarget(this.name) : undefined;
  }
  constructor(
    readonly name: string,
    readonly action: string,
    options: { failTimes?: number; uncertainTimes?: number } = {},
    private uncertain = options.uncertainTimes ?? 0,
  ) {
    this.failures = options.failTimes ?? 0;
  }
  render({
    markdown,
    data,
    publication,
  }: {
    markdown: string;
    data: ArticleApprovedData;
    publication?: PublicationPayload;
  }): DestinationPreview {
    return {
      body: `<!-- ${this.name} preview for ${data.publicationId}/${data.postId} -->\n${markdown}`,
      contentType: "text/markdown",
      ...(publication ? { publication } : {}),
      ...(data.approvalKind === "owner-draft-rehearsal"
        ? { draftAuthorization: assertDraftAuthorizationTarget(data, this) }
        : {}),
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
