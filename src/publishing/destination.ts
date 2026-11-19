import { z } from "zod";

/**
 * Publication destination contract and Substack destination controller.
 *
 * The pipeline talks only to {@link PublicationDestination}: create a draft,
 * read a draft's status back by its stable ID, publish a draft. Vendor
 * details (authentication, session cookies, endpoints, body format) stay in
 * a {@link SubstackDestinationClient} behind {@link SubstackDestinationController}.
 *
 * Safety rules the contract encodes:
 * - A draft ID is returned by creation and must be persisted (#67) before
 *   publishing; every later step addresses that ID, never "the latest draft".
 * - A lost or ambiguous publish response is an `uncertain` failure, never
 *   success and never a reason to create another draft. {@link reconcilePublication}
 *   reads the stored draft back to settle it, or leaves it uncertain.
 * - Draft creation itself has no idempotency key at the destination, so an
 *   uncertain creation cannot be reconciled by ID; it is reported as
 *   `uncertain` and must be resolved by an operator rather than retried
 *   blindly. This is a stated limitation of the destination, not hidden.
 * - Subscriber email is an explicit option, defaulting to off.
 * - Expired authentication is a visible `auth-expired` failure, not a retry.
 *
 * Live access is unverified: no destination, credentials or authorised test
 * content have been supplied. The controlled destination proves the contract.
 */

export const DraftContentSchema = z
  .object({
    title: z.string().trim().min(1).max(280),
    subtitle: z.string().trim().max(280).optional(),
    /** Article body in Markdown; formatting is converted by the vendor client. */
    bodyMarkdown: z.string().trim().min(1).max(200_000),
    /** Link to the original post the article responds to (required by the draft structure). */
    sourceUrl: z.url({ protocol: /^https$/ }),
  })
  .strict();
export type DraftContent = z.infer<typeof DraftContentSchema>;

export const DraftStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("draft"), draftId: z.string().min(1) }).strict(),
  z
    .object({
      state: z.literal("published"),
      draftId: z.string().min(1),
      url: z.url({ protocol: /^https$/ }),
      publishedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z.object({ state: z.literal("not-found"), draftId: z.string().min(1) }).strict(),
]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

export interface PublishOptions {
  /** Send the post to subscribers by email. Defaults to false. */
  sendEmail?: boolean;
  signal?: AbortSignal;
}

export interface PublishedReceipt {
  draftId: string;
  url: string;
  publishedAt: string;
}

export type DestinationFailure =
  | "auth-expired"
  | "rate-limited"
  | "rejected"
  | "not-found"
  | "unavailable"
  | "uncertain"
  | "cancelled";

export class DestinationError extends Error {
  constructor(
    readonly category: DestinationFailure,
    readonly retryable: boolean,
  ) {
    super(`publication destination ${category}`);
    this.name = "DestinationError";
  }
}

/** Application-owned destination interface used by the publisher. */
export interface PublicationDestination {
  createDraft(content: DraftContent, signal?: AbortSignal): Promise<{ draftId: string }>;
  getStatus(draftId: string, signal?: AbortSignal): Promise<DraftStatus>;
  publish(draftId: string, options?: PublishOptions): Promise<PublishedReceipt>;
}

/**
 * Vendor client port. Implementations hold authentication and endpoint
 * details and may throw anything; the controller classifies failures and
 * validates every response.
 */
export interface SubstackDestinationClient {
  createDraft(
    draft: { title: string; subtitle?: string; body: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
  getDraft(draftId: string, signal?: AbortSignal): Promise<unknown>;
  publishDraft(
    draftId: string,
    options: { sendEmail: boolean },
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** Error shape vendor clients can throw to signal a known condition. */
export class VendorResponseError extends Error {
  constructor(
    readonly status: number | "timeout" | "network",
    message = "vendor request failed",
  ) {
    super(message);
    this.name = "VendorResponseError";
  }
}

const CreatedSchema = z.looseObject({ id: z.union([z.string().min(1), z.number().int()]) });
const VendorDraftSchema = z.looseObject({
  id: z.union([z.string().min(1), z.number().int()]),
  // Required: a read-back without an explicit state proves nothing either way.
  is_published: z.boolean(),
  canonical_url: z.string().optional(),
  post_date: z.string().nullable().optional(),
});

/** Render the agreed simple draft body: article, then the original-post link. */
export function renderDraftBody(content: DraftContent): string {
  return `${content.bodyMarkdown.trim()}\n\n---\n\nOriginal post: ${content.sourceUrl}\n`;
}

function classify(error: unknown, phase: "create" | "read" | "publish"): DestinationError {
  if (error instanceof DestinationError) return error;
  const status = error instanceof VendorResponseError ? error.status : "network";
  if (status === 401 || status === 403) return new DestinationError("auth-expired", false);
  if (status === 404) return new DestinationError("not-found", false);
  if (status === 429) return new DestinationError("rate-limited", true);
  if (typeof status === "number" && status >= 400 && status < 500) {
    return new DestinationError("rejected", false);
  }
  // Timeouts, network errors and 5xx: for writes the outcome is unknown.
  if (phase === "read") return new DestinationError("unavailable", true);
  return new DestinationError("uncertain", false);
}

export class SubstackDestinationController implements PublicationDestination {
  constructor(private readonly client: SubstackDestinationClient) {}

  async createDraft(content: DraftContent, signal?: AbortSignal): Promise<{ draftId: string }> {
    const valid = DraftContentSchema.parse(content);
    if (signal?.aborted) throw new DestinationError("cancelled", false);
    let raw: unknown;
    try {
      raw = await this.client.createDraft(
        {
          title: valid.title,
          ...(valid.subtitle ? { subtitle: valid.subtitle } : {}),
          body: renderDraftBody(valid),
        },
        signal,
      );
    } catch (error) {
      // Aborting after the request was sent does not undo it: the draft may exist.
      if (signal?.aborted) throw new DestinationError("uncertain", false);
      throw classify(error, "create");
    }
    const parsed = CreatedSchema.safeParse(raw);
    // A success response without a usable ID cannot be persisted: treat as uncertain.
    if (!parsed.success) throw new DestinationError("uncertain", false);
    return { draftId: String(parsed.data.id) };
  }

  async getStatus(draftId: string, signal?: AbortSignal): Promise<DraftStatus> {
    if (!draftId) throw new DestinationError("rejected", false);
    let raw: unknown;
    try {
      raw = await this.client.getDraft(draftId, signal);
    } catch (error) {
      if (signal?.aborted) throw new DestinationError("cancelled", false);
      const failure = classify(error, "read");
      if (failure.category === "not-found") return { state: "not-found", draftId };
      throw failure;
    }
    const parsed = VendorDraftSchema.safeParse(raw);
    if (!parsed.success || String(parsed.data.id) !== draftId) {
      throw new DestinationError("unavailable", true);
    }
    if (parsed.data.is_published) {
      const status = DraftStatusSchema.safeParse({
        state: "published",
        draftId,
        url: parsed.data.canonical_url,
        publishedAt: parsed.data.post_date
          ? new Date(parsed.data.post_date).toISOString()
          : undefined,
      });
      if (!status.success) throw new DestinationError("unavailable", true);
      return status.data;
    }
    return { state: "draft", draftId };
  }

  async publish(draftId: string, options: PublishOptions = {}): Promise<PublishedReceipt> {
    if (!draftId) throw new DestinationError("rejected", false);
    try {
      await this.client.publishDraft(
        draftId,
        { sendEmail: options.sendEmail ?? false },
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted) throw new DestinationError("uncertain", false);
      throw classify(error, "publish");
    }
    // Confirm by read-back rather than trusting the publish response body.
    let status: DraftStatus;
    try {
      status = await this.getStatus(draftId, options.signal);
    } catch {
      throw new DestinationError("uncertain", false);
    }
    if (status.state !== "published") throw new DestinationError("uncertain", false);
    return { draftId, url: status.url, publishedAt: status.publishedAt };
  }
}

export type ReconciliationResult =
  | { outcome: "published"; receipt: PublishedReceipt }
  | { outcome: "unpublished" }
  | { outcome: "missing" }
  | { outcome: "uncertain" };

/**
 * Settle an uncertain publication by reading back the stored draft ID. Never
 * creates or publishes anything; a read failure leaves it uncertain.
 */
export async function reconcilePublication(
  destination: PublicationDestination,
  draftId: string,
  signal?: AbortSignal,
): Promise<ReconciliationResult> {
  let status: DraftStatus;
  try {
    status = await destination.getStatus(draftId, signal);
  } catch {
    return { outcome: "uncertain" };
  }
  if (status.state === "published") {
    return {
      outcome: "published",
      receipt: { draftId, url: status.url, publishedAt: status.publishedAt },
    };
  }
  if (status.state === "not-found") return { outcome: "missing" };
  return { outcome: "unpublished" };
}
