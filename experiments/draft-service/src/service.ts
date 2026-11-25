import { createHash } from "node:crypto";
import { z } from "zod";
import { DestinationError, type DraftDestination, type DraftReadback } from "./destination.ts";
import { DeliveryStore, type DeliveryRecord } from "./store.ts";
import { canonicalJson, markdownToProseMirror, UnsupportedMarkdownError } from "./substack/prosemirror.ts";

/**
 * Shared duplicate-safe draft delivery (#912, contract doc/experiments/n8n-vs-mastra.md).
 *
 * - Same request ID with the same payload returns the same draft. The same ID
 *   with a different payload is a conflict.
 * - The intent is stored durably before the create call. An interrupted or
 *   ambiguous create is reconciled against the destination by the draft's
 *   unique labelled title before anything else is attempted. If that cannot
 *   settle it, the outcome is `uncertain`, and only an explicit operator
 *   action allows another create.
 * - A draft counts as delivered only after readback shows the expected title,
 *   unpublished, with no email sent.
 */

const Platform = z.enum(["n8n", "mastra"]);
const Attempt = z.string().regex(/^(n8n|mastra)-\d{8}T\d{6}Z-[0-9a-f]{4}$/);

export const DeliveryRequestSchema = z
  .object({
    requestId: z.string().max(120),
    experiment: z.literal("exp-911"),
    platform: Platform,
    attempt: Attempt,
    title: z.string().min(1).max(280),
    subtitle: z.string().max(300).optional(),
    bodyMarkdown: z.string().min(1).max(60_000),
    source: z.object({
      item: z.string().regex(/^substack:[a-z0-9-]+:\d+$/),
      version: z.string().regex(/^substack:[a-z0-9-]+:\d+@sha256:[0-9a-f]{64}$/),
      url: z.url({ protocol: /^https$/ }).max(500),
    }),
    article: z.string().regex(/^(n8n|mastra)-\d{8}T\d{6}Z-[0-9a-f]{4}\/article@sha256:[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.requestId !== `${r.experiment}:${r.platform}:${r.attempt}`)
      ctx.addIssue({ code: "custom", path: ["requestId"], message: "must equal <experiment>:<platform>:<attempt>" });
    if (!r.attempt.startsWith(`${r.platform}-`))
      ctx.addIssue({ code: "custom", path: ["attempt"], message: "must start with the platform" });
    if (!r.title.startsWith(`[${r.experiment} ${r.platform} ${r.attempt}] `))
      ctx.addIssue({ code: "custom", path: ["title"], message: "must start with the label [<experiment> <platform> <attempt>] " });
    if (!r.article.startsWith(`${r.attempt}/`))
      ctx.addIssue({ code: "custom", path: ["article"], message: "must belong to the attempt" });
  });
export type DeliveryRequest = z.infer<typeof DeliveryRequestSchema>;

export type Outcome =
  | "created"
  | "existing"
  | "conflict"
  | "uncertain"
  | "failed"
  | "invalid"
  | "forbidden"
  | "not-found";

export interface DeliveryResponse {
  httpStatus: number;
  body: {
    status: Outcome;
    requestId?: string;
    draftId?: string | null;
    editorUrl?: string;
    readback?: { titleMatches: boolean; published: boolean; emailSent: boolean };
    receiptId?: string | null;
    payloadHash?: string;
    destination?: string;
    createAttempts?: number;
    error?: string | null;
    issues?: { path: string; message: string }[];
  };
}

const HTTP: Record<Outcome, number> = {
  created: 201,
  existing: 200,
  conflict: 409,
  uncertain: 503,
  failed: 502,
  invalid: 400,
  forbidden: 403,
  "not-found": 404,
};

export class DraftService {
  /** One in-flight operation per request ID (single-instance service). */
  private readonly locks = new Map<string, Promise<unknown>>();

  private readonly store: DeliveryStore;
  private readonly destination: () => DraftDestination;
  private readonly now: () => Date;

  constructor(store: DeliveryStore, destination: () => DraftDestination, now: () => Date = () => new Date()) {
    this.store = store;
    this.destination = destination;
    this.now = now;
  }

  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(id)) await this.locks.get(id)!.catch(() => undefined);
    const p = fn();
    this.locks.set(id, p);
    try {
      return await p;
    } finally {
      this.locks.delete(id);
    }
  }

  async deliver(callerPlatform: string, raw: unknown): Promise<DeliveryResponse> {
    const parsed = DeliveryRequestSchema.safeParse(raw);
    if (!parsed.success)
      return respond("invalid", {
        issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    const req = parsed.data;
    if (req.platform !== callerPlatform)
      return respond("forbidden", { error: "platform-mismatch: a caller may only deliver its own platform's requests" });

    let body: unknown;
    try {
      body = markdownToProseMirror(req.bodyMarkdown);
    } catch (e) {
      if (e instanceof UnsupportedMarkdownError) return respond("invalid", { issues: [{ path: "bodyMarkdown", message: e.message }] });
      throw e;
    }
    const payloadHash = `sha256:${createHash("sha256").update(canonicalJson(req)).digest("hex")}`;

    return this.locked(req.requestId, async () => {
      const dest = this.destination();
      let record = this.store.get(req.requestId);
      if (record && record.payloadHash !== payloadHash)
        return respond("conflict", { requestId: req.requestId, payloadHash: record.payloadHash, error: "same request ID, different payload" });
      if (record && record.destination !== dest.identity)
        return respond("conflict", { requestId: req.requestId, error: "request was recorded against a different destination" });

      if (record?.state === "created") return this.view(record, "existing", dest, true);
      if (record?.state === "pending" || record?.state === "uncertain") {
        // A previous create may have happened: reconcile, never blindly create.
        record = await this.reconcile(record, dest);
        return this.view(record, record.state === "created" ? "existing" : "uncertain", dest, false);
      }
      if (!record) {
        this.store.insertPending(
          { requestId: req.requestId, payloadHash, platform: req.platform, title: req.title, destination: dest.identity },
          this.stamp(),
        );
      }
      // New, or previously failed with no draft created: create now.
      return this.create(req.requestId, { title: req.title, subtitle: req.subtitle, body }, dest);
    });
  }

  private async create(requestId: string, draft: { title: string; subtitle?: string; body: unknown }, dest: DraftDestination) {
    this.store.beginCreate(requestId, this.stamp());
    let id: string;
    try {
      ({ id } = await dest.create(draft));
    } catch (e) {
      const code = e instanceof DestinationError ? e.code : "unexpected";
      if (code === "uncertain" || code === "unexpected") {
        const record = await this.reconcile(this.store.get(requestId)!, dest);
        return this.view(record, record.state === "created" ? "created" : "uncertain", dest, false);
      }
      this.store.mark(requestId, "failed", `destination-${code}`, this.stamp());
      return this.view(this.store.get(requestId)!, "failed", dest, false);
    }
    return this.confirm(this.store.get(requestId)!, id, dest, "created");
  }

  /** Reads the draft back; records it as created only when it is the expected unpublished, no-email draft. */
  private async confirm(record: DeliveryRecord, draftId: string, dest: DraftDestination, outcome: "created" | "existing") {
    let rb: DraftReadback;
    try {
      rb = await dest.read(draftId);
    } catch {
      this.store.mark(record.requestId, "uncertain", "readback-unavailable", this.stamp());
      return this.view(this.store.get(record.requestId)!, "uncertain", dest, false);
    }
    if (rb.title !== record.title || rb.published || rb.emailSent) {
      this.store.mark(record.requestId, "uncertain", "readback-mismatch: draft is not the expected unpublished, no-email draft", this.stamp());
      return this.view(this.store.get(record.requestId)!, "uncertain", dest, false, rb);
    }
    const receiptId = `rcpt-${createHash("sha256").update(`${record.requestId}|${draftId}|${record.payloadHash}`).digest("hex").slice(0, 24)}`;
    this.store.markCreated(record.requestId, draftId, receiptId, this.stamp());
    return this.view(this.store.get(record.requestId)!, outcome, dest, false, rb);
  }

  /** Looks for the labelled draft at the destination. Exactly one match settles it as created. */
  private async reconcile(record: DeliveryRecord, dest: DraftDestination): Promise<DeliveryRecord> {
    let matches: DraftReadback[];
    try {
      matches = await dest.findByTitle(record.title);
    } catch {
      this.store.mark(record.requestId, "uncertain", "reconcile-unavailable", this.stamp());
      return this.store.get(record.requestId)!;
    }
    if (matches.length === 1) {
      await this.confirm(record, matches[0]!.id, dest, "existing");
      return this.store.get(record.requestId)!;
    }
    this.store.mark(
      record.requestId,
      "uncertain",
      matches.length === 0 ? "no-matching-draft-found" : `multiple-matching-drafts (${matches.length})`,
      this.stamp(),
    );
    return this.store.get(record.requestId)!;
  }

  /** Status lookup, limited to the caller's own platform. */
  async status(callerPlatform: string, requestId: string, refresh: boolean): Promise<DeliveryResponse> {
    const record = this.store.get(requestId);
    if (!record) return respond("not-found", { requestId });
    if (record.platform !== callerPlatform) return respond("forbidden", { error: "platform-mismatch" });
    const dest = this.destination();
    if (refresh && (record.state === "pending" || record.state === "uncertain"))
      return this.locked(requestId, async () => {
        const r = await this.reconcile(this.store.get(requestId)!, dest);
        return this.view(r, r.state === "created" ? "existing" : "uncertain", dest, false);
      });
    return this.view(record, record.state === "created" ? "existing" : record.state === "failed" ? "failed" : "uncertain", dest, refresh && record.state === "created");
  }

  /**
   * Explicit operator recovery for an `uncertain` delivery whose draft cannot
   * be found. It marks the delivery `failed`, so the next identical request
   * creates a new draft. Refused while a matching draft exists.
   */
  async allowRecreate(callerPlatform: string, requestId: string): Promise<DeliveryResponse> {
    return this.locked(requestId, async () => {
      const record = this.store.get(requestId);
      if (!record) return respond("not-found", { requestId });
      if (record.platform !== callerPlatform) return respond("forbidden", { error: "platform-mismatch" });
      const dest = this.destination();
      if (record.state !== "uncertain") return this.view(record, record.state === "created" ? "existing" : (record.state as Outcome), dest, false);
      const r = await this.reconcile(record, dest);
      if (r.state === "created") return this.view(r, "existing", dest, false);
      if (r.error !== "no-matching-draft-found") return this.view(r, "uncertain", dest, false);
      this.store.mark(requestId, "failed", "operator-allowed-recreate: no matching draft found", this.stamp());
      return this.view(this.store.get(requestId)!, "failed", dest, false);
    });
  }

  list(callerPlatform: string, limit: number) {
    return this.store
      .list(limit)
      .filter((r) => r.platform === callerPlatform)
      .map(({ requestId, state, draftId, createAttempts, updatedAt, error, receiptId }) => ({
        requestId,
        state,
        draftId,
        createAttempts,
        updatedAt,
        error,
        receiptId,
      }));
  }

  private async view(record: DeliveryRecord, status: Outcome, dest: DraftDestination, readback: boolean, rb?: DraftReadback): Promise<DeliveryResponse> {
    if (readback && record.draftId && !rb) {
      try {
        rb = await dest.read(record.draftId);
      } catch {
        /* status stays as recorded; readback simply omitted */
      }
    }
    return respond(status, {
      requestId: record.requestId,
      draftId: record.draftId,
      ...(record.draftId && record.state === "created" ? { editorUrl: dest.editorUrl(record.draftId) } : {}),
      ...(rb ? { readback: { titleMatches: rb.title === record.title, published: rb.published, emailSent: rb.emailSent } } : {}),
      receiptId: record.receiptId,
      payloadHash: record.payloadHash,
      destination: record.destination,
      createAttempts: record.createAttempts,
      error: record.error,
    });
  }

  private stamp() {
    return this.now().toISOString();
  }
}

function respond(status: Outcome, body: Omit<DeliveryResponse["body"], "status">): DeliveryResponse {
  return { httpStatus: HTTP[status], body: { status, ...body } };
}
