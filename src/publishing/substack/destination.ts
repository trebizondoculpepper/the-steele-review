import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DestinationUnavailableError,
  UncertainDeliveryError,
  type DeliveryReceipt,
  type DestinationAdapter,
  type DestinationPreview,
  type ReconcileContext,
} from "../approved-article.js";
import type { ArticleApprovedData } from "../../events/article-approved-event.js";
import { SubstackError, type SubstackClient, type SubstackDraft } from "./client.js";
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

const PreviewBodySchema = z
  .object({
    title: z.string().min(1),
    subtitle: z.string(),
    body: z.unknown(),
    fingerprint: z.string(),
  })
  .strict();

export interface SubstackDestinationOptions {
  /** Destination name for receipts and consumers, e.g. "substack". */
  name?: string;
  /** Delay before retrying after an expired session (the owner must replace it). */
  authRetryMs?: number;
  rateLimitRetryMs?: number;
  unavailableRetryMs?: number;
}

const titleOf = (markdown: string, data: ArticleApprovedData): string => {
  const heading = /^# (.+)$/m.exec(markdown)?.[1]?.trim();
  return (heading ?? `A response: ${data.postId.replace(/-/g, " ")}`).slice(0, 280);
};

function receiptFor(draft: SubstackDraft): Omit<DeliveryReceipt, "destination" | "action"> {
  return {
    simulated: false,
    externalId: draft.id,
    deliveredAt: new Date().toISOString(),
  };
}

export class SubstackDraftDestination implements DestinationAdapter {
  readonly name: string;
  readonly action = "draft";
  private readonly options: Required<Omit<SubstackDestinationOptions, "name">>;

  constructor(
    private readonly client: Pick<SubstackClient, "createDraft" | "getDraft" | "listDrafts">,
    options: SubstackDestinationOptions = {},
  ) {
    this.name = options.name ?? "substack";
    this.options = {
      authRetryMs: options.authRetryMs ?? 15 * 60_000,
      rateLimitRetryMs: options.rateLimitRetryMs ?? 5 * 60_000,
      unavailableRetryMs: options.unavailableRetryMs ?? 60_000,
    };
  }

  render({ markdown, data }: { markdown: string; data: ArticleApprovedData }): DestinationPreview {
    // A top-level heading becomes the title rather than body text.
    const bodyMarkdown = markdown.replace(/^# .+\n+/m, "");
    const body = markdownToProseMirror(bodyMarkdown);
    const preview = {
      title: titleOf(markdown, data),
      subtitle: "",
      body,
      fingerprint: bodyFingerprint(body),
    };
    return { body: JSON.stringify(preview), contentType: SUBSTACK_CONTENT_TYPE };
  }

  private unavailable(error: SubstackError): DestinationUnavailableError {
    if (error.code === "auth-expired") {
      return new DestinationUnavailableError("auth-expired", this.options.authRetryMs);
    }
    if (error.code === "rate-limited") {
      return new DestinationUnavailableError("rate-limited", this.options.rateLimitRetryMs);
    }
    return new DestinationUnavailableError("unavailable", this.options.unavailableRetryMs);
  }

  private matches(draft: SubstackDraft, preview: z.infer<typeof PreviewBodySchema>): boolean {
    if ((draft.draft_title ?? "") !== preview.title || !draft.draft_body) return false;
    try {
      return bodyFingerprint(JSON.parse(draft.draft_body)) === preview.fingerprint;
    } catch {
      return false;
    }
  }

  async deliver(preview: DestinationPreview, _key: string) {
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
    try {
      ({ id } = await this.client.createDraft({
        title: p.title,
        subtitle: p.subtitle,
        body: p.body,
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
    if (stored.is_published) throw new UncertainDeliveryError();
    if (!this.matches(stored, p)) {
      // Created but not as sent: record it so it is reviewed, never re-created.
      throw new UncertainDeliveryError();
    }
    return receiptFor(stored);
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
    const p = PreviewBodySchema.parse(JSON.parse(context.preview.body));
    const intentAt = context.intentAt ? Date.parse(context.intentAt) : NaN;
    const found: SubstackDraft[] = [];
    let sameTitle = 0;
    let covered = false;
    try {
      for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
        const drafts = await this.client.listDrafts({
          limit: RECONCILE_PAGE_SIZE,
          offset: page * RECONCILE_PAGE_SIZE,
        });
        found.push(...drafts.filter((d) => this.matches(d, p)));
        sameTitle += drafts.filter((d) => (d.draft_title ?? "") === p.title).length;
        if (drafts.length < RECONCILE_PAGE_SIZE) {
          covered = true; // the complete list
          break;
        }
        const oldest = drafts
          .map((d) => (d.draft_created_at ? Date.parse(d.draft_created_at) : NaN))
          .filter((t) => !Number.isNaN(t))
          .sort((a, b) => a - b)[0];
        if (!Number.isNaN(intentAt) && oldest !== undefined && oldest < intentAt) {
          covered = true; // reached drafts older than the attempt
          break;
        }
      }
    } catch {
      return "unknown";
    }
    // A same-title draft whose body differs (for example one that read back
    // differently) is ambiguous: an operator decides, nothing is re-created.
    if (found.length === 1 && sameTitle === 1) return { delivered: receiptFor(found[0]!) };
    if (sameTitle === 0 && covered) return { delivered: false };
    return "unknown";
  }
}

/** Stable digest of a preview, for logs and tests (never the body itself). */
export const previewDigest = (preview: DestinationPreview) =>
  `sha256:${createHash("sha256").update(preview.body).digest("hex")}`;
