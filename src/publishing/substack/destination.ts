import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DestinationUnavailableError,
  UncertainDeliveryError,
  assertDraftAuthorizationTarget,
  type DeliveryReceipt,
  type DestinationAdapter,
  type DestinationPreview,
  type ReconcileContext,
  type DraftDeliveryControl,
} from "../approved-article.js";
import type { ArticleApprovedData } from "../../events/article-approved-event.js";
import type { PublicationPayload } from "../../drafting/publication-payload.js";
import type { DraftTarget } from "../../content/owner-draft-authorization.js";
import {
  SubstackError,
  substackDraftOriginIdentity,
  type SubstackClient,
  type SubstackDraft,
} from "./client.js";
import { bodyFingerprint, markdownToProseMirror } from "./prosemirror.js";

/**
 * Live Substack destination, draft-only (#385; design in doc/architecture/06).
 *
 * `deliver` creates one editable draft from the exact verified article, reads
 * it back and checks the stored title and body against what was sent. It
 * never publishes and never sends subscriber email. `reconcile` resolves an
 * uncertain create by listing recent drafts: a match by exact title and body
 * fingerprint is delivered; "not delivered" requires a listing that reaches
 * back past the recorded intent time (or is complete); anything else is
 * unknown, for an operator.
 */

export const SUBSTACK_CONTENT_TYPE = "application/vnd.substack.draft+json";
export const MAX_RECONCILE_PAGES = 4;
export const RECONCILE_PAGE_SIZE = 25;

const BylineId = z.string().regex(/^[0-9]+$/);

const PreviewBodySchema = z
  .object({
    title: z.string().min(1),
    subtitle: z.string(),
    body: z.unknown(),
    fingerprint: z.string(),
    /** The explicit byline pinned when the intent was rendered, if any. */
    bylineId: BylineId.optional(),
  })
  .strict();

export interface SubstackDestinationOptions {
  /** Destination name for receipts and consumers, e.g. "substack". */
  name?: string;
  /** Delay before retrying after an expired session (the owner must replace it). */
  authRetryMs?: number;
  rateLimitRetryMs?: number;
  unavailableRetryMs?: number;
  /**
   * Explicit destination byline ID (#459). Omitted means no explicit byline:
   * the platform keeps its own default. A changed configuration never alters
   * an already-rendered intent, because the preview pins the chosen ID.
   */
  bylineId?: string;
  /** Reads the live configuration handler before any new owner-draft effect. */
  deliveryControl?: DraftDeliveryControl;
}

const titleOf = (markdown: string, data: ArticleApprovedData): string => {
  const heading = /^# (.+)$/m.exec(markdown)?.[1]?.trim();
  return (heading ?? `A response: ${data.postId.replace(/-/g, " ")}`).slice(
    0,
    280,
  );
};

function receiptFor(
  draft: SubstackDraft,
  ownerDraft = false,
): Omit<DeliveryReceipt, "destination" | "action"> {
  return {
    simulated: false,
    externalId: draft.id,
    deliveredAt: new Date().toISOString(),
    ...(ownerDraft
      ? {
          draftSafety: {
            unpublished: true as const,
            emailTimestampAbsent: true as const,
          },
        }
      : {}),
  };
}

/** Pure protocol-adapter target projection. No publishing credentials are read. */
export function substackDraftTarget(input: {
  origin: string;
  name: string;
  bylineId?: string;
}): DraftTarget {
  if (
    input.bylineId !== undefined &&
    !BylineId.safeParse(input.bylineId).success
  )
    throw new Error("substack: invalid draft target");
  return {
    name: input.name,
    provider: "substack",
    action: "draft",
    capability: "unpublished-no-email-v1",
    identity: `sha256:${createHash("sha256")
      .update(
        JSON.stringify([
          "substack-owner-draft-v1",
          substackDraftOriginIdentity(input.origin),
          input.name,
          input.bylineId ?? null,
        ]),
      )
      .digest("hex")}`,
  };
}

export class SubstackDraftDestination implements DestinationAdapter {
  readonly name: string;
  readonly action = "draft";
  private readonly options: Required<
    Omit<SubstackDestinationOptions, "name" | "bylineId" | "deliveryControl">
  >;
  private readonly bylineId: string | undefined;
  private readonly deliveryControl: DraftDeliveryControl | undefined;

  constructor(
    private readonly client: Pick<
      SubstackClient,
      "createDraft" | "getDraft" | "listDrafts"
    > &
      Partial<Pick<SubstackClient, "draftTargetIdentity">>,
    options: SubstackDestinationOptions = {},
  ) {
    this.name = options.name ?? "substack";
    if (
      options.bylineId !== undefined &&
      !BylineId.safeParse(options.bylineId).success
    ) {
      throw new Error("substack: invalid byline id");
    }
    this.bylineId = options.bylineId;
    this.deliveryControl = options.deliveryControl;
    this.options = {
      authRetryMs: options.authRetryMs ?? 15 * 60_000,
      rateLimitRetryMs: options.rateLimitRetryMs ?? 5 * 60_000,
      unavailableRetryMs: options.unavailableRetryMs ?? 60_000,
    };
  }

  /** The approved structured fields are used verbatim, never re-derived (#458). */
  readonly supportsPublicationPayload = true;
  get draftTarget(): DraftTarget | undefined {
    if (!this.client.draftTargetIdentity) return undefined;
    return {
      name: this.name,
      provider: "substack",
      action: "draft",
      capability: "unpublished-no-email-v1",
      identity: `sha256:${createHash("sha256")
        .update(
          JSON.stringify([
            "substack-owner-draft-v1",
            this.client.draftTargetIdentity,
            this.name,
            this.bylineId ?? null,
          ]),
        )
        .digest("hex")}`,
    };
  }

  private validScope(preview: DestinationPreview) {
    return (
      preview.draftAuthorization === undefined ||
      JSON.stringify(preview.draftAuthorization) ===
        JSON.stringify(this.draftTarget)
    );
  }
  private safeState(draft: SubstackDraft, preview: DestinationPreview) {
    if (draft.is_published || draft.email_sent_at != null) return false;
    return (
      !preview.draftAuthorization ||
      (draft.is_published === false &&
        Object.hasOwn(draft, "email_sent_at") &&
        draft.email_sent_at === null)
    );
  }
  private async requireLive(preview: DestinationPreview) {
    if (!preview.draftAuthorization) return;
    let allowed: boolean | undefined;
    try {
      allowed = await this.deliveryControl?.allow(preview.draftAuthorization);
    } catch {
      throw new DestinationUnavailableError(
        "unavailable",
        this.options.unavailableRetryMs,
      );
    }
    if (!allowed)
      throw new DestinationUnavailableError(
        "paused",
        this.options.unavailableRetryMs,
      );
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
    // A top-level heading becomes the title rather than body text.
    const bodyMarkdown = markdown.replace(/^# .+\n+/m, "");
    const body = markdownToProseMirror(bodyMarkdown);
    // Structured approvals carry the exact verified title and subtitle. A
    // legacy body-only approval keeps the documented fallback: the draft
    // heading, with no subtitle, because none was ever verified.
    const structured =
      publication?.mode === "structured" ? publication.fields : undefined;
    const preview = {
      title: structured?.title ?? titleOf(markdown, data),
      subtitle: structured?.subtitle ?? "",
      body,
      fingerprint: bodyFingerprint(body),
      ...(this.bylineId === undefined ? {} : { bylineId: this.bylineId }),
    };
    return {
      body: JSON.stringify(preview),
      contentType: SUBSTACK_CONTENT_TYPE,
      ...(data.approvalKind === "owner-draft-rehearsal"
        ? { draftAuthorization: assertDraftAuthorizationTarget(data, this) }
        : {}),
    };
  }

  /**
   * Waiting without spending the attempt budget is only for conditions that
   * resolve by themselves or by the owner (session, rate limit, outage). A
   * permanent rejection (invalid request or response) is returned as a plain
   * error, so it spends attempts and ends in an inspectable failure.
   */
  private unavailable(error: SubstackError): Error {
    if (error.code === "invalid-response")
      return new Error(`substack: ${error.code}`);
    if (error.code === "auth-expired") {
      return new DestinationUnavailableError(
        "auth-expired",
        this.options.authRetryMs,
      );
    }
    if (error.code === "rate-limited") {
      return new DestinationUnavailableError(
        "rate-limited",
        this.options.rateLimitRetryMs,
      );
    }
    return new DestinationUnavailableError(
      "unavailable",
      this.options.unavailableRetryMs,
    );
  }

  private matches(
    draft: SubstackDraft,
    preview: z.infer<typeof PreviewBodySchema>,
  ): boolean {
    if (draft.is_published || draft.email_sent_at != null) return false;
    if ((draft.draft_title ?? "") !== preview.title || !draft.draft_body)
      return false;
    // Title, subtitle and body must all match the approved payload: two
    // approvals can differ only in subtitle while sharing title and body.
    if ((draft.draft_subtitle ?? "") !== preview.subtitle) return false;
    // A requested byline must be evidenced by the read-back. A draft that
    // dropped it is never claimed as delivered with attribution.
    if (preview.bylineId !== undefined) {
      const ids = (draft.draft_bylines ?? [])
        .map((b) => b.id)
        .filter((id) => id !== undefined);
      if (!ids.includes(preview.bylineId)) return false;
    }
    try {
      return (
        bodyFingerprint(JSON.parse(draft.draft_body)) === preview.fingerprint
      );
    } catch {
      return false;
    }
  }

  async deliver(preview: DestinationPreview, _key: string) {
    if (!this.validScope(preview))
      throw new Error("substack: draft authorization target mismatch");
    await this.requireLive(preview);
    const p = PreviewBodySchema.parse(JSON.parse(preview.body));
    // Preflight: a read with no side effects, so an expired session is found
    // before anything is created.
    try {
      await this.client.listDrafts({ limit: 1 });
    } catch (error) {
      if (error instanceof SubstackError) throw this.unavailable(error);
      throw error;
    }
    let id: string;
    await this.requireLive(preview);
    try {
      ({ id } = await this.client.createDraft({
        title: p.title,
        subtitle: p.subtitle,
        body: p.body,
        ...(p.bylineId === undefined ? {} : { bylines: [p.bylineId] }),
      }));
    } catch (error) {
      if (error instanceof SubstackError && error.code === "uncertain") {
        throw new UncertainDeliveryError();
      }
      // Rejected outright (auth, rate limit, invalid request): nothing was created.
      if (error instanceof SubstackError) throw this.unavailable(error);
      throw new UncertainDeliveryError();
    }
    // The draft exists from here on: any doubt is uncertainty, never a retry.
    let stored: SubstackDraft;
    try {
      stored = await this.client.getDraft(id);
    } catch {
      throw new UncertainDeliveryError();
    }
    // Unexpected state is never retried (a retry would create a second draft).
    if (!this.safeState(stored, preview)) throw new UncertainDeliveryError();
    if (!this.matches(stored, p)) {
      // Created but not as sent: record it so it is reviewed, never re-created.
      throw new UncertainDeliveryError();
    }
    return receiptFor(stored, !!preview.draftAuthorization);
  }

  async reconcile(
    _key: string,
    context?: ReconcileContext,
  ): Promise<
    | { delivered: Omit<DeliveryReceipt, "destination" | "action"> }
    | { delivered: false }
    | "unknown"
  > {
    if (!context) return "unknown";
    if (!this.validScope(context.preview)) return "unknown";
    await this.requireLive(context.preview);
    const p = PreviewBodySchema.parse(JSON.parse(context.preview.body));
    const intentAt = context.intentAt ? Date.parse(context.intentAt) : NaN;
    const found: SubstackDraft[] = [];
    // Same headline (title only) makes a listing inconclusive: a draft that
    // shares the title but carries a different subtitle may be an ambiguous
    // earlier attempt. Same submission (title and subtitle) is the stricter
    // count used to claim this approval was delivered.
    let sameHeadline = 0;
    let sameSubmission = 0;
    let covered = false;
    try {
      for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
        const drafts = await this.client.listDrafts({
          limit: RECONCILE_PAGE_SIZE,
          offset: page * RECONCILE_PAGE_SIZE,
        });
        found.push(...drafts.filter((d) => this.matches(d, p)));
        const headline = drafts.filter(
          (d) => (d.draft_title ?? "") === p.title,
        );
        sameHeadline += headline.length;
        sameSubmission += headline.filter(
          (d) => (d.draft_subtitle ?? "") === p.subtitle,
        ).length;
        if (drafts.length < RECONCILE_PAGE_SIZE) {
          covered = true; // the complete list
          break;
        }
        const oldest = drafts
          .map((d) =>
            d.draft_created_at ? Date.parse(d.draft_created_at) : NaN,
          )
          .filter((t) => !Number.isNaN(t))
          .sort((a, b) => a - b)[0];
        if (
          !Number.isNaN(intentAt) &&
          oldest !== undefined &&
          oldest < intentAt
        ) {
          covered = true; // reached drafts older than the attempt
          break;
        }
      }
    } catch (error) {
      // An expired session or outage is not ambiguity: wait and try again.
      if (error instanceof SubstackError && error.code !== "invalid-response") {
        throw this.unavailable(error);
      }
      return "unknown";
    }
    // A same-title draft whose body differs (for example one that read back
    // differently) is ambiguous: an operator decides, nothing is re-created.
    if (found.length === 1 && sameSubmission === 1) {
      let selected = found[0]!;
      if (context.preview.draftAuthorization) {
        try {
          selected = await this.client.getDraft(selected.id);
        } catch {
          return "unknown";
        }
      }
      return this.safeState(selected, context.preview) &&
        this.matches(selected, p)
        ? {
            delivered: receiptFor(
              selected,
              !!context.preview.draftAuthorization,
            ),
          }
        : "unknown";
    }
    if (sameHeadline === 0 && covered) return { delivered: false };
    return "unknown";
  }
}

/** Stable digest of a preview, for logs and tests (never the body itself). */
export const previewDigest = (preview: DestinationPreview) =>
  `sha256:${createHash("sha256").update(preview.body).digest("hex")}`;

/**
 * Live Substack publication with subscriber email (#789).
 *
 * Owner decision: future approved posts are published automatically and sent
 * to subscribers. Approvals before the configured activation time (the
 * existing backlog) and owner draft rehearsals are not eligible and are never
 * touched. For an eligible approval, `deliver` first creates and verifies the
 * draft exactly as the draft destination does, then publishes it with email
 * and reads it back as published. Once the draft exists, any doubt (an
 * uncertain publish, a read-back that is not published) is an uncertain
 * delivery for an operator, never a retry: a retry could publish or email
 * twice. `reconcile` therefore never claims a publication on its own.
 */
export class SubstackPublishDestination implements DestinationAdapter {
  readonly name: string;
  readonly action = "publish";
  readonly supportsPublicationPayload = true;
  private readonly draft: SubstackDraftDestination;
  private readonly publishFrom: number;
  private readonly withoutEmail: ReadonlySet<string>;

  constructor(
    private readonly client: Pick<
      SubstackClient,
      "createDraft" | "getDraft" | "listDrafts" | "publishDraft"
    >,
    options: Omit<SubstackDestinationOptions, "deliveryControl"> & {
      /** Only approvals at or after this instant are published (ISO 8601). */
      publishFrom: string;
      /**
       * Posts (`publicationId/postId`) published without subscriber email, for
       * an owner-authorized validation run (#388). Every other post is
       * published with email as before.
       */
      withoutEmail?: ReadonlySet<string>;
    },
  ) {
    const from = Date.parse(options.publishFrom);
    if (!Number.isFinite(from))
      throw new Error("substack: invalid publish activation time");
    this.publishFrom = from;
    this.withoutEmail = options.withoutEmail ?? new Set();
    this.name = options.name ?? "substack";
    this.draft = new SubstackDraftDestination(client, options);
  }

  eligible(data: ArticleApprovedData): boolean {
    return (
      data.approvalKind !== "owner-draft-rehearsal" &&
      Date.parse(data.approvedAt) >= this.publishFrom
    );
  }

  render(
    article: Parameters<DestinationAdapter["render"]>[0],
  ): DestinationPreview {
    if (!this.eligible(article.data))
      throw new Error("substack: approval not eligible to publish");
    const preview = this.draft.render(article);
    return this.withoutEmail.has(
      `${article.data.publicationId}/${article.data.postId}`,
    )
      ? { ...preview, subscriberEmail: "suppressed" }
      : preview;
  }

  async deliver(preview: DestinationPreview, key: string) {
    if (preview.draftAuthorization)
      throw new Error("substack: drafts are never published");
    const created = await this.draft.deliver(preview, key);
    const id = created.externalId!;
    const send = preview.subscriberEmail !== "suppressed";
    try {
      await this.client.publishDraft(id, { send });
    } catch {
      // The draft exists. Whether the publish was rejected or its outcome is
      // unknown, nothing is retried automatically: an operator decides.
      throw new UncertainDeliveryError();
    }
    let stored: SubstackDraft;
    try {
      stored = await this.client.getDraft(id);
    } catch {
      throw new UncertainDeliveryError();
    }
    if (stored.is_published !== true) throw new UncertainDeliveryError();
    // A suppressed send must read back with no email timestamp.
    if (!send && stored.email_sent_at) throw new UncertainDeliveryError();
    return {
      simulated: false,
      externalId: id,
      deliveredAt: new Date().toISOString(),
      publicationSafety: {
        published: true as const,
        subscriberEmail: send
          ? ("requested" as const)
          : ("suppressed" as const),
      },
    };
  }

  async reconcile(): Promise<"unknown"> {
    // Never infer a publication or an email from a listing: an operator decides.
    return "unknown";
  }
}
